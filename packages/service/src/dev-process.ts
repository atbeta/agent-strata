// Long-running commands a session starts — `npm run dev`, `mvn spring-boot:run`
// — held by the service instead of being smuggled into a detached window.
//
// Why this exists at all: the agent has no way to run a command that outlives
// a turn. The shell tool takes a timeout and, when it expires, kills the whole
// process tree; so a dev server has to be started some other way, and the way
// the model knows is `Start-Process`, which on Windows opens a console window
// per child and detaches it from anything that could stop it later.
//
// Here the service owns the process: it reads the output, answers "is it up",
// and stops the whole tree on request. The window never appears because the
// spawn asks for no console, and nothing is orphaned because the service is
// what holds the handle.

import { spawn as bunSpawn, type Subprocess } from "bun";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { basename } from "node:path";
import { jobPlan } from "./dev-process-job";

/**
 * Where a command is in its life.
 *
 * The table outlives the process, so "not running" is not one thing. A
 * command that was stopped is stopped; one whose process disappeared without
 * anyone stopping it is lost; one the service found still running after it
 * died is an orphan, and the only honest thing to say about it is that it
 * was there and was cleaned up.
 */
export type DevState = "running" | "stopped" | "lost" | "orphaned";

/** One running command, as the UI and the agent both see it. */
export interface DevProcess {
  id: string;
  session_id: string;
  command: string;
  cwd: string;
  pid: number | undefined;
  started_at: number;
  /** Undefined while it runs; the exit code once it has stopped. */
  exit_code: number | null;
  /** True when it stopped because someone asked it to. */
  stopped: boolean;
  /** Set when the spawn itself failed, before a pid existed. */
  error?: string;
  /** Last line of output, for a one-line status. */
  last_line?: string;
  /** The port it was asked to listen on, when the caller named one. */
  port?: number;
  /**
   * Whether it has proved it can serve.
   *
   * `unknown` is the honest answer for a command nobody named a port for: a
   * dev server that prints nothing recognisable is not a failure, and calling
   * it ready would be a guess.
   */
  ready?: "yes" | "no" | "unknown";
  /** How long the port took to answer, when it answered. */
  ready_ms?: number;
  /** Where it is in its life. */
  state?: DevState;
  /** When it stopped, for a record that outlived its process. */
  stopped_at?: number;
  /** The shell the command ran in, so a caller knows what syntax it accepted. */
  shell?: string;
}

/**
 * What a stop actually achieved.
 *
 * A stop that says "stopped" while the port is still held is the worst
 * answer a service can give: the next command collides with it and nobody
 * knows why. So a stop reports what it can prove — whether the tree is gone,
 * and what is left if it is not.
 */
export interface DevStopResult {
  /** The process was known and the stop was carried out. */
  stopped: boolean;
  /** Nothing of the command is left running. */
  clean: boolean;
  /** Processes that survived the stop. */
  residual: number[];
  /** The port, when it was known. */
  port?: number;
  /** Whether that port is free now. */
  port_free?: boolean;
}

export interface DevLogLine {
  at: number;
  stream: "out" | "err";
  text: string;
}

export interface DevStartInput {
  session_id: string;
  command: string;
  cwd: string;
  /**
   * The port the command is expected to serve on.
   *
   * Given one, `start` waits until it accepts a connection before returning, so
   * a caller that needs the server up does not have to sleep and guess. Omitted,
   * a port printed in the output is used instead; failing that, `start` returns
   * as soon as the process has proved it did not exit immediately.
   */
  port?: number;
  /** How long to wait for the port, in milliseconds. */
  waitMs?: number;
}

/** Bounded per-process output. A dev server that runs for hours must not grow without limit. */
const MAX_LOG_LINES = 2000;
/** Bounded process table. Sessions that end take their processes with them. */
const MAX_PROCESSES = 32;

/** Default wait for a named port to accept a connection. */
const DEFAULT_WAIT_MS = 30_000;

/**
 * Grace period for a port read out of the output.
 *
 * Something that printed a URL is already listening, so this only covers the
 * gap between writing the line and accepting the socket. A long wait here would
 * be spent on ports that are never going to open.
 */
const ANNOUNCED_WAIT_MS = 2_000;

/**
 * How long a port announcement is waited for.
 *
 * This is the hard cap; the usual end of the wait comes sooner, when the
 * command stops talking. A dev server prints the port it serves on a moment
 * after it starts, and that moment is often longer than the liveness check
 * because the supervisor has to come up first — so giving up after a second
 * reports a server that is about to be ready as one that never will be.
 */
const ANNOUNCE_WINDOW_MS = 8_000;

/**
 * How long a command may be quiet before its silence is taken for an answer.
 *
 * A watcher prints a line and then says nothing for an hour. Waiting for a
 * port that is never going to be announced would make every start of one
 * look hung.
 */
const SILENCE_MS = 1_200;

/**
 * How long "no output at all" is tolerated before silence counts.
 *
 * On Windows the supervisor — a PowerShell process that compiles its job
 * helpers — has to come up before the command can print anything, and on a
 * slow machine that alone outlasts the silence window. Treating "nothing
 * said yet" as a watcher would return answers about a command that has not
 * actually started yet.
 */
const FIRST_OUTPUT_GRACE_MS = 5_000;

/**
 * Text decoders, tried in order.
 *
 * `cmd.exe` on a Chinese Windows writes GBK (code page 936), and decoding that
 * as UTF-8 turns every message into `�����ɹ�`. UTF-8 is tried first because it is
 * the common case and `fatal: true` makes it reject anything that is not UTF-8
 * instead of silently producing replacement characters.
 */
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const GBK = new TextDecoder("gbk");

function decodeLine(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    return GBK.decode(bytes);
  }
}

/**
 * Colour and cursor control, which a log pane has no terminal to interpret.
 *
 * `FORCE_COLOR=0` covers the libraries that honour it; plenty of tools write
 * escapes regardless, and `[32m` in a transcript reads as corruption.
 */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Whether something accepts a connection on a loopback port right now.
 *
 * Both loopback families are asked, because a server that binds "localhost"
 * on Windows lands on ::1 and nothing on 127.0.0.1. A probe that only asked
 * the IPv4 address was asking a port that was never going to answer, and the
 * answer it produced — "no port answered yet" — was about the probe rather
 * than about the server.
 */
async function portAccepts(port: number, timeoutMs = 500): Promise<boolean> {
  const answers = await Promise.all([
    acceptsOn("127.0.0.1", port, timeoutMs),
    acceptsOn("::1", port, timeoutMs),
  ]);
  return answers.some(Boolean);
}

function acceptsOn(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/**
 * The pids still holding a port.
 *
 * Only used when a stop could not prove the port was free: the answer to
 * "what is still on it" is the difference between a clean stop and a stop
 * that has to be reported as a failure.
 */
async function portHolders(port: number): Promise<number[]> {
  if (process.platform !== "win32") return posixPortHolders(port);
  const out = await new Promise<string>((resolve) => {
    try {
      // No `-p` here: with it, netstat lists only the IPv4 table, and a
      // server that bound "localhost" on Windows is on ::1 — so the pids of
      // exactly the processes worth naming would be missing.
      const child = bunSpawn(["netstat", "-ano"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        windowsHide: true,
      });
      let text = "";
      void (async () => {
        const reader = child.stdout as ReadableStream<Uint8Array>;
        const decoder = new TextDecoder();
        for await (const chunk of reader) text += decoder.decode(chunk, { stream: true });
        resolve(text);
      })();
    } catch {
      resolve("");
    }
  });
  const holders = new Set<number>();
  const pattern = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, "gim");
  for (const match of out.matchAll(pattern)) {
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) holders.add(pid);
  }
  return [...holders];
}

/**
 * The pids listening on a port, on a machine that is not Windows.
 *
 * `lsof` asks the kernel which processes hold the socket, which is a different
 * question from "does anything answer on this port" — the terminal answers the
 * second one, and it answers it about the wrong process when the port is held
 * by something this table has never heard of.
 *
 * It is why a port could be refused before a second tree was created at all:
 * without it the check below never fired on a mac, the second command started
 * anyway, and the two of them fought over the port with the first one looking
 * broken. Windows has `netstat` for the same job.
 *
 * A machine without `lsof` answers with nothing rather than with a guess. The
 * caller reads an empty answer as "nobody is holding it", which is the answer
 * it gave before this existed.
 */
async function posixPortHolders(port: number): Promise<number[]> {
  const out = await new Promise<string>((resolve) => {
    let child: Subprocess<"ignore", "pipe", "ignore"> | undefined;
    const spawnLsof = (lsof: string) => {
      child = bunSpawn([lsof, "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
    };
    try {
      spawnLsof("lsof");
    } catch {
      try {
        // macOS keeps `lsof` in /usr/sbin, which is not on the path of a
        // program started from a window.
        spawnLsof("/usr/sbin/lsof");
      } catch {
        resolve("");
        return;
      }
    }
    let text = "";
    void (async () => {
      const reader = child!.stdout as ReadableStream<Uint8Array>;
      const decoder = new TextDecoder();
      for await (const chunk of reader) text += decoder.decode(chunk, { stream: true });
      resolve(text);
    })();
  });
  const holders = new Set<number>();
  // `lsof -t` answers with one pid per line and exits non-zero when nothing
  // holds the port, which is the answer and not a failure.
  for (const token of out.split(/\s+/)) {
    const pid = Number(token);
    if (Number.isInteger(pid) && pid > 0) holders.add(pid);
  }
  return [...holders];
}

/** A port a dev server announced, when the caller did not name one. */
const ANNOUNCED_PORT = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})\b/i;

function announcedPort(line: string): number | undefined {
  const hit = ANNOUNCED_PORT.exec(line);
  if (!hit) return undefined;
  const port = Number(hit[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

interface Entry {
  info: DevProcess;
  child: Subprocess<"ignore", "pipe", "pipe"> | undefined;
  logs: DevLogLine[];
  listeners: Set<(line: DevLogLine) => void>;
  /** When the command last said something, for the silence check. */
  lastOutputAt?: number;
  /** True for a record the table inherited from a previous run. */
  restored?: boolean;
}

/** One record as it is written down, so a later run can finish the story. */
interface PersistedProcess {
  id: string;
  session_id: string;
  command: string;
  cwd: string;
  pid?: number;
  started_at: number;
  port?: number;
  state: DevState;
  exit_code?: number | null;
  stopped_at?: number;
}

export type DevEvent =
  | { type: "dev.started"; session_id: string; process: DevProcess }
  | { type: "dev.output"; session_id: string; process_id: string; line: DevLogLine }
  | { type: "dev.exited"; session_id: string; process: DevProcess };

export interface DevManager {
  start(input: DevStartInput): Promise<DevProcess>;
  list(sessionID?: string): DevProcess[];
  get(id: string): DevProcess | undefined;
  logs(id: string, tail?: number): DevLogLine[];
  /** Stop a command, and say what is left of it. */
  stop(id: string): Promise<DevStopResult>;
  /** Every process a session owns, stopped together. Called when a session goes away. */
  stopSession(sessionID: string): Promise<number>;
  stopAll(): Promise<void>;
  /** Kill what a previous run left behind. Called once, at startup. */
  reapStale(): Promise<number>;
  subscribe(listener: (event: DevEvent) => void): () => void;
}

export interface DevManagerOptions {
  /**
   * Where the live process table is written.
   *
   * A service that is killed outright cannot run `stopAll`, so its dev servers
   * outlive it. The file is the only thing that survives to tell the next run
   * what to clean up.
   */
  pidFile?: string;
}

let counter = 0;
function nextID(): string {
  counter += 1;
  return `dev_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/**
 * The command a shell would run.
 *
 * `npm` and `mvn` on Windows are `.cmd` shims, and a shim cannot be executed
 * directly by CreateProcess. Going through `cmd /C` is one extra layer, and
 * because that layer is ours it is also the layer we can tell not to open a
 * window.
 */
/**
 * The shell a command runs in, on Windows.
 *
 * `cmd` is the last resort, not the default. The model writes PowerShell —
 * `-WindowStyle Hidden`, `$env:X`, `;` chaining — and handing that to `cmd /c`
 * fails in ways that look like the command was wrong rather than the shell.
 * OpenCode makes the same choice for its own shell tool: pwsh, then Windows
 * PowerShell, then git bash, then cmd. This follows it without git bash, which
 * would change the syntax the model is expected to write a second time.
 */
type WindowsShell = { path: string; name: "pwsh" | "powershell" | "cmd" };

/**
 * Pick a shell from what was found on the machine.
 *
 * Pure, and separate from the lookup, because the ordering is the whole point:
 * `pwsh` first, `powershell` next, `cmd` only when neither exists. A model
 * writes PowerShell, and handing that to cmd fails in a way that reads like the
 * command was wrong.
 */
export function chooseWindowsShell(found: {
  pwsh?: string | null;
  powershell?: string | null;
  comspec?: string | null;
}): WindowsShell {
  if (found.pwsh) return { path: found.pwsh, name: "pwsh" };
  if (found.powershell) return { path: found.powershell, name: "powershell" };
  return { path: found.comspec || "cmd.exe", name: "cmd" };
}

let windowsShell: WindowsShell | undefined;

function resolveWindowsShell(): WindowsShell {
  if (windowsShell) return windowsShell;
  windowsShell = chooseWindowsShell({
    pwsh: Bun.which("pwsh"),
    powershell: Bun.which("powershell"),
    comspec: process.env.COMSPEC,
  });
  return windowsShell;
}

/** The shell commands run in, for the UI and for the model to read. */
export function commandShell(): string {
  if (process.platform === "win32") return resolveWindowsShell().name;
  return process.env.SHELL || "/bin/sh";
}

/**
 * The program that runs the supervisor, which is not the shell that runs the
 * command.
 *
 * The supervisor is a PowerShell program — reaching the job object APIs from
 * a process this service spawns means PowerShell on Windows — so a machine
 * with neither `pwsh` nor `powershell` cannot have one. Such a machine falls
 * back to a plain spawn: the old behaviour, and better than a supervisor that
 * cannot run.
 */
function resolveSupervisorPath(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const shell = resolveWindowsShell();
  return shell.name === "cmd" ? undefined : shell.path;
}

function argv(command: string): string[] {
  if (process.platform === "win32") {
    const shell = resolveWindowsShell();
    // `/d /s /c` is how a command string is handed to cmd.exe without its own
    // quote-stripping rules mangling it; the PowerShell flags mirror what
    // OpenCode passes, so a profile cannot print into the transcript and an
    // interactive prompt cannot wait for input that will never come.
    if (shell.name === "cmd") return [shell.path, "/d", "/s", "/c", command];
    return [shell.path, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
  }
  // `-c`, not `-lc`: a login shell sources the user's profile, which prints
  // whatever their prompt and tooling print and can fail on constructs a
  // non-interactive shell does not have. The environment is already inherited
  // from the service, so there is nothing a profile would add.
  return [process.env.SHELL || "/bin/sh", "-c", command];
}

/**
 * Options that keep a child off the desktop and stoppable as a tree.
 *
 * `windowsHide` is the one that matters for the window: without it a console
 * program spawned from a GUI process gets its own console window, which is
 * exactly the popup this whole module exists to remove.
 *
 * `detached` is platform-specific, and the two platforms need opposite values:
 *
 * - On POSIX it must be true. `detached` makes the child its own process group
 *   leader, which is the only way `kill(-pid)` reaches its grandchildren. A
 *   child that is not a group leader answers `kill(-pid)` with ESRCH and leaves
 *   the whole tree running — measured, not assumed.
 * - On Windows it must stay false. `taskkill /T` walks parent-to-child links
 *   rather than a process group, so a group is no help there, and a detached
 *   child is one that outlives the service.
 */
function spawnOptions(cwd: string, env: Record<string, string>) {
  return {
    cwd,
    env,
    stdin: "ignore" as const,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    windowsHide: true,
    detached: process.platform !== "win32",
  };
}

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  // A dev server that inherits the service's own PORT would collide with it.
  delete out.STRATA_PORT;
  delete out.STRATA_OPENCODE_URL;
  delete out.STRATA_OPENCODE_USERNAME;
  delete out.STRATA_OPENCODE_PASSWORD;
  // Coloured output is unreadable in a log pane that has no terminal.
  out.FORCE_COLOR = "0";
  out.NO_COLOR = "1";
  return out;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a pid still names a live process.
 *
 * Signal 0 asks the question without sending anything. It is the only portable
 * check here; on Windows a killed-but-not-yet-reaped process answers as alive,
 * which is why the caller kills rather than trusting the answer on its own.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists and belongs to someone else. That is not
    // ours to kill, and it is not one of ours either, so treat it as gone.
    return false;
  }
}

/**
 * End a process and everything it started.
 *
 * A dev server is a shell that runs a script that runs a runtime: killing the
 * shell alone leaves the runtime holding the port. On Windows `taskkill /T`
 * walks the tree; elsewhere the process group does it.
 *
 * On Windows the command usually runs inside a job object, and killing the
 * supervisor that holds the job is enough — the operating system takes the
 * tree with it. This is the belt to that braces: it reaches a tree the job
 * missed, and it is the only thing that can reach a command this service
 * did not start itself.
 */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    try {
      bunSpawn(["taskkill", "/PID", String(pid), "/T", "/F"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      });
    } catch {
      // Best effort.
    }
    return;
  }
  try {
    // A negative pid signals the whole group. A process that is its own group
    // leader is the normal case here, because that is what the shell shim is.
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/**
 * The table as the last run left it.
 *
 * Both shapes are read. The file used to be a bare array of the live
 * processes, and one written by an older build is still on disk after an
 * upgrade — and it is exactly the file that tells the next run which
 * processes to clean up.
 */
export function readRecords(file: string): PersistedProcess[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { processes?: unknown }).processes)
      ? (parsed as { processes: unknown[] }).processes
      : [];
  const records: PersistedProcess[] = [];
  let index = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Partial<PersistedProcess>;
    index += 1;
    // A record that cannot be named is still a record: the pid in it is
    // still running, and skipping it would leak the very process the file
    // exists to describe.
    const id = typeof item.id === "string" && item.id.length > 0 ? item.id : `dev_unknown_${index}`;
    records.push({
      id,
      session_id: typeof item.session_id === "string" ? item.session_id : "",
      command: String(item.command ?? ""),
      cwd: String(item.cwd ?? ""),
      pid: typeof item.pid === "number" ? item.pid : undefined,
      started_at: typeof item.started_at === "number" ? item.started_at : Date.now(),
      port: typeof item.port === "number" ? item.port : undefined,
      // An older file has no state: a record in it was live when it was
      // written, so it is either running still or lost.
      state: item.state ?? "running",
      exit_code: typeof item.exit_code === "number" ? item.exit_code : undefined,
      stopped_at: typeof item.stopped_at === "number" ? item.stopped_at : undefined,
    });
  }
  return records;
}

/**
 * When a process was created, in the same clock the records keep.
 *
 * Undefined means there is no such process: it is gone, or it never was.
 */
function processStartedAt(pid: number): number | undefined {
  if (process.platform === "win32") {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString("o")`;
    const out = Bun.spawnSync(["powershell", "-NoLogo", "-NoProfile", "-Command", script], {
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    });
    const text = out.stdout.toString().trim();
    if (text.length === 0) return undefined;
    const at = Date.parse(text);
    return Number.isFinite(at) ? at : undefined;
  }
  const out = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
    // `ps` prints the creation time in the zone it is told to use, and a date
    // string with no zone on it is read in the zone the runtime happens to be
    // in. Those are two different zones unless something forces them to agree,
    // and nothing did: the records keep epoch milliseconds, `ps` printed the
    // machine's local time, and a runtime running in UTC read that local time
    // as UTC. Every process then looked eight hours in the future, and a live
    // orphan looked like a stranger wearing its number — so it was never
    // cleaned up, and the port it held stayed held.
    //
    // So `ps` is told to print UTC, and the string is read as UTC.
    env: { ...process.env, TZ: "UTC" },
  });
  const text = out.stdout.toString().trim();
  if (text.length === 0) return undefined;
  const at = parseProcessStart(text);
  return Number.isFinite(at) ? at : undefined;
}

/** The months `ps` names a creation time with. */
const PS_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The creation time `ps` printed, read in the zone it printed it in.
 *
 * `ps -o lstart=` answers "Sun Oct 25 16:22:14 2026": a weekday, a month, a
 * day, a clock and a year, and no zone — so it is read here as UTC, which is
 * the zone `ps` was asked for.
 */
function parseProcessStart(text: string): number | undefined {
  const [weekday, monthName, dayText, clockText, yearText] = text.split(/\s+/);
  if (!weekday || !monthName || !dayText || !clockText || !yearText) return undefined;
  const month = PS_MONTHS.indexOf(monthName);
  const day = Number(dayText);
  const year = Number(yearText);
  const clock = clockText.split(":").map(Number);
  if (month < 0 || !Number.isInteger(day) || !Number.isInteger(year) || clock.length !== 3) {
    return undefined;
  }
  const at = Date.UTC(year, month, day, clock[0], clock[1], clock[2]);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * Whether the pid in a record still belongs to the command it was written for.
 *
 * A pid is a number the operating system hands out again once it is free, so
 * a record left behind by an earlier run may well name a process that has
 * nothing to do with it — and killing that one takes an innocent tree with
 * it. The clock is what tells them apart: the process the record is about was
 * created when the record says the command started, and a process created
 * later than that is somebody else wearing the same number.
 */
function stillOurs(record: PersistedProcess): boolean {
  const pid = record.pid;
  if (pid === undefined) return false;
  const created = processStartedAt(pid);
  if (created === undefined) return false;
  // A moment of slack covers the spawn itself; anything beyond that is a
  // different process.
  return created <= record.started_at + 2_000;
}

export function createDevManager(options: DevManagerOptions = {}): DevManager {
  const entries = new Map<string, Entry>();
  const listeners = new Set<(event: DevEvent) => void>();

  /**
   * The cleanup of what the previous run left behind.
   *
   * A start waits for it. The orphan of a crashed run is holding a port, and
   * handing that port to a new command before the orphan has let go of it
   * produces a failure that looks like the caller's fault.
   */
  let cleanup: Promise<unknown> = Promise.resolve();

  /**
   * Wait for the orphans to let go of what they held.
   *
   * The kill is a request and the process being gone is the fact, so the fact
   * is the one that is waited for. A record with no port has nothing to wait
   * for on the port, and one that is not an orphan was never running.
   */
  const settleOrphans = async (records: PersistedProcess[]) => {
    for (const record of records) {
      if (record.state !== "orphaned") continue;
      const deadline = Date.now() + 3_000;
      while (record.pid !== undefined && alive(record.pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (record.port === undefined) continue;
      const portDeadline = Date.now() + 3_000;
      while (Date.now() < portDeadline) {
        if (!(await portAccepts(record.port, 200))) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  };

  /**
   * The table as it is written down.
   *
   * It carries the finished commands too, not only the live ones. The table
   * used to hold nothing but running processes, so the moment a command
   * stopped its record vanished — and a record that vanishes cannot be asked
   * about afterwards. A service that is restarted then came back with an
   * empty list and no way to say what the previous run had been holding.
   *
   * The file is the only thing that survives a service that is killed
   * outright, so it is also the only thing the next run can use to find the
   * processes this one left behind.
   */
  const persist = () => {
    if (!options.pidFile) return;
    const rows: PersistedProcess[] = [...entries.values()]
      .map((entry) => ({
        id: entry.info.id,
        session_id: entry.info.session_id,
        command: entry.info.command,
        cwd: entry.info.cwd,
        pid: entry.info.pid,
        started_at: entry.info.started_at,
        port: entry.info.port,
        state: entry.info.state ?? (entry.info.exit_code === null ? "running" : "stopped"),
        exit_code: entry.info.exit_code,
        stopped_at: entry.info.exit_code === null ? undefined : entry.info.stopped_at,
      }))
      // The newest are the ones worth keeping: the table is bounded, and an
      // old command is a story nobody is still asking about.
      .sort((a, b) => b.started_at - a.started_at)
      .slice(0, MAX_PROCESSES);
    try {
      writeFileSync(options.pidFile, JSON.stringify({ version: 2, processes: rows }));
    } catch {
      // A table that cannot be written is a table the next run will not have;
      // losing it must not stop a command the reader asked for.
    }
  };

  const emit = (event: DevEvent) => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A listener that throws is a listener that stops hearing, not a reason
        // to fail the process it was watching.
      }
    }
  };

  const push = (entry: Entry, stream: "out" | "err", text: string) => {
    const line: DevLogLine = { at: Date.now(), stream, text };
    entry.logs.push(line);
    if (entry.logs.length > MAX_LOG_LINES) entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES);
    entry.info.last_line = text;
    entry.lastOutputAt = line.at;
    emit({ type: "dev.output", session_id: entry.info.session_id, process_id: entry.info.id, line });
  };

  /**
   * Whether the command has stopped talking.
   *
   * Silence is what a command says when it is not going to announce
   * anything, and it is the only answer available: a watcher that has said
   * nothing for a moment is a watcher, not a server that is about to print
   * its port.
   */
  const quiet = (entry: Entry, began: number): boolean => {
    // No output at all yet is "still coming up", not "silent": the supervisor
    // itself has to start before the command can print, and on a slow machine
    // that alone outlasts the silence window.
    if (entry.logs.length === 0) return Date.now() - began > FIRST_OUTPUT_GRACE_MS;
    return Date.now() - (entry.lastOutputAt ?? began) > SILENCE_MS;
  };

  const read = async (entry: Entry, stream: "out" | "err", source: ReadableStream<Uint8Array>) => {
    // Bytes are buffered and decoded a line at a time, not through a streaming
    // decoder: the encoding is decided per line, because a Windows console and a
    // Node tool can disagree about it inside one process's output.
    let pending = new Uint8Array(0);
    let clixml = false;
    const flush = (bytes: Uint8Array) => {
      let text = stripAnsi(decodeLine(bytes)).replace(/\r$/, "");
      // A progress record reaching a redirected PowerShell stream is written
      // as a `#< CLIXML` blob — readable by a CLIXML reader, noise in a log.
      if (text.trimStart().startsWith("#< CLIXML")) {
        clixml = true;
        return;
      }
      if (clixml) {
        // The blob's XML lines follow the marker; the first non-XML line is
        // output again.
        if (text.trimStart().startsWith("<")) return;
        clixml = false;
      }
      if (text.trim().length === 0) return;
      push(entry, stream, text);
      // A server that announces its port is telling the truth about where to
      // look; a caller who named one is not overruled.
      if (entry.info.port === undefined) {
        const port = announcedPort(text);
        if (port !== undefined) entry.info.port = port;
      }
    };
    try {
      for await (const chunk of source) {
        const merged = new Uint8Array(pending.length + chunk.length);
        merged.set(pending);
        merged.set(chunk, pending.length);
        let start = 0;
        for (let i = 0; i < merged.length; i++) {
          if (merged[i] !== 0x0a) continue;
          flush(merged.subarray(start, i));
          start = i + 1;
        }
        pending = merged.subarray(start);
      }
      if (pending.length > 0) flush(pending);
    } catch {
      // The pipe closing under us is how a killed process looks from here.
    }
  };

  const settle = (entry: Entry, code: number | null) => {
    if (entry.info.exit_code !== null) return;
    entry.info.exit_code = code ?? 0;
    entry.info.stopped_at = Date.now();
    // The process is gone, so the record is finished. It used to keep the
    // state it was given at the start, which meant a command that crashed on
    // its own still read as running — and the panel counted it as one.
    entry.info.state = "stopped";
    entry.child = undefined;
    persist();
    emit({ type: "dev.exited", session_id: entry.info.session_id, process: entry.info });
  };

  /**
   * Stop a command and prove it stopped.
   *
   * The order matters. The supervisor is killed first — on Windows that
   * closes the job handle and the operating system takes the whole tree with
   * it — and the tree walk is only the belt to that braces. Then the port is
   * asked whether anything is still listening, because a port that is still
   * held is the part the reader will hit next.
   *
   * What comes back says what happened, not what was hoped for. A stop that
   * could not prove the port is free reports it, with the pids that are still
   * holding it.
   */
  const stopEntry = async (entry: Entry): Promise<DevStopResult> => {
    const child = entry.child;
    const pid = entry.info.pid;
    const port = entry.info.port;
    if (entry.info.exit_code !== null) {
      // The command is already finished, and its record says how it ended.
      // Stopping it again does not change that: a command that was cleaned
      // up as an orphan stays an orphan, because that is what happened to it
      // and a reader may be asking exactly that.
      const portHeld = port !== undefined && (await portAccepts(port, 200));
      const residual = port !== undefined && portHeld ? await portHolders(port) : [];
      if (pid !== undefined && alive(pid)) residual.push(pid);
      return {
        stopped: true,
        clean: residual.length === 0 && !portHeld,
        residual,
        port,
        port_free: port === undefined ? undefined : !portHeld,
      };
    }
    entry.info.stopped = true;
    entry.info.state = "stopped";
    if (!child && pid === undefined) {
      // A spawn that never produced a pid has nothing to signal.
      settle(entry, null);
      return { stopped: true, clean: true, residual: [], port, port_free: port === undefined };
    }
    // The shell exits before the programs it started do, so killing the pid is
    // not killing the tree. A dev server is a shell that runs a script that
    // runs a runtime, and it is the runtime that holds the port.
    //
    // On Windows the pid is a supervisor holding a job object: killing it
    // closes the job and the operating system takes the tree with it, without
    // anyone walking links that a middle process may already have broken.
    try {
      child?.kill();
    } catch {
      // Already gone; the exit handler settles it.
    }
    if (pid !== undefined) {
      killTree(pid);
    }

    // Give the tree the moment it needs to go, then ask what is left.
    const { residual, portHeld } = await residualProcesses(pid, port);
    const clean = residual.length === 0 && !portHeld;
    // The command is still running if its root is: the record has to keep
    // saying what is true, because a reader who is told "stopped" stops
    // looking for the process that is still holding the port.
    const stillUp = pid !== undefined && alive(pid);
    if (stillUp) {
      entry.info.stopped = false;
      entry.info.state = "running";
    } else {
      // It is gone. If the port is still held, something else holds it —
      // the answer names who, because that is what will collide with the
      // next command.
      if (entry.info.exit_code === null) settle(entry, null);
      entry.info.stopped = true;
      entry.info.state = "stopped";
    }
    persist();
    return {
      // The answer says what happened: a root that is still standing was not
      // stopped, whatever the stop asked for.
      stopped: !stillUp,
      clean,
      residual,
      port,
      port_free: port === undefined ? undefined : !portHeld,
    };
  };

  /**
   * What survived a stop.
   *
   * Two questions, asked in the order that costs the least. The process
   * itself is checked first, because a command that never opened a port has
   * nothing else to be wrong about. A port that is still answering is
   * checked next, and the pids holding it are the ones worth reporting: a
   * server that is still serving is the failure that will bite the next
   * start.
   *
   * The answer is a pair, not a list. A port that is still held is the fact
   * that matters even when the pids cannot be named — the reader needs to
   * know the port is taken, not only which process took it.
   */
  const residualProcesses = async (
    pid: number | undefined,
    port: number | undefined,
  ): Promise<{ residual: number[]; portHeld: boolean }> => {
    // The tree needs a moment to come apart. The probe is short-lived here:
    // a port that is still held answers or refuses at once, and a stop that
    // takes ten seconds is a stop the caller has stopped watching.
    for (let i = 0; i < 10; i++) {
      const rootGone = pid === undefined || !alive(pid);
      const portHeld = port !== undefined && (await portAccepts(port, 200));
      if (rootGone && !portHeld) {
        // The root is gone, but the tree it held may still be coming apart:
        // the operating system tears a job down asynchronously, and a runtime
        // that is about to let go of its port would otherwise be reported as
        // still holding it. One more look before calling the stop clean.
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (port === undefined || !(await portAccepts(port, 200))) {
          return { residual: [], portHeld: false };
        }
      }
      if ((i === 3 || i === 6) && pid !== undefined && alive(pid)) {
        // The root is still there after the first attempts: reach it again,
        // this time by the tree walk.
        killTree(pid);
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const residual = new Set<number>();
    if (pid !== undefined && alive(pid)) residual.add(pid);
    let portHeld = false;
    if (port !== undefined) {
      portHeld = await portAccepts(port, 200);
      for (const holder of await portHolders(port)) residual.add(holder);
    }
    return { residual: [...residual], portHeld };
  };

  const trim = () => {
    if (entries.size <= MAX_PROCESSES) return;
    // Oldest finished process first; a running one is never evicted, because
    // evicting it would lose the only handle that can stop it.
    const finished = [...entries.values()]
      .filter((entry) => entry.info.exit_code !== null)
      .sort((a, b) => a.info.started_at - b.info.started_at);
    for (const entry of finished) {
      if (entries.size <= MAX_PROCESSES) break;
      entries.delete(entry.info.id);
    }
  };

  /**
   * Keep a record the last run left behind.
   *
   * It goes into the table like any other, so the reader can still ask about
   * it. A command that vanished on its own is lost; one that was found
   * running and cleaned up is an orphan; one that was stopped before the
   * service died is simply stopped.
   */
  const keepRestored = (record: PersistedProcess): DevProcess => {
    if (entries.has(record.id)) return entries.get(record.id)!.info;
    const info: DevProcess = {
      id: record.id,
      session_id: record.session_id,
      command: record.command,
      cwd: record.cwd,
      pid: record.pid,
      started_at: record.started_at,
      exit_code: record.exit_code ?? 1,
      stopped: record.state === "stopped" || record.state === "orphaned",
      port: record.port,
      state: record.state,
      stopped_at: record.stopped_at,
    };
    entries.set(record.id, { info, child: undefined, logs: [], listeners: new Set(), restored: true });
    return info;
  };

  return {
    async start(input) {
      const command = input.command.trim();
      if (command.length === 0) throw new Error("command is required");
      if (!isDirectory(input.cwd)) throw new Error(`not a directory: ${input.cwd}`);
      // The previous run's orphans are cleaned up first: one of them may still
      // be holding the port this command wants.
      await cleanup;

      const id = nextID();
      const info: DevProcess = {
        id,
        session_id: input.session_id,
        command,
        cwd: input.cwd,
        pid: undefined,
        started_at: Date.now(),
        exit_code: null,
        stopped: false,
        state: "running",
        // Recorded so a caller reading the result knows what syntax the command
        // was written in — the model writes PowerShell, and `cmd /c` would have
        // silently failed on it.
        shell: commandShell(),
      };

      // One port, one tree.
      //
      // A second command on a port that is already being served cannot work,
      // and starting it anyway leaves two trees fighting over the port: the
      // second one fails with an address already in use that has nothing to
      // do with the second command, and the first one is the one that looks
      // broken. Refusing is the only answer that keeps one port, one server.
      if (input.port !== undefined) {
        const holder = [...entries.values()].find(
          (entry) => entry.info.exit_code === null && entry.info.port === input.port,
        );
        if (holder) {
          throw new Error(
            `port ${input.port} is already served by ${holder.info.id} (${holder.info.command}) — stop it first`,
          );
        }
        // A port this table knows nothing about may still be taken — by a
        // command another run left behind, or by something that was never
        // ours. The operating system is the authority on who holds a port,
        // and it can answer before a second tree is created rather than
        // after it has failed.
        const holders = await portHolders(input.port);
        if (holders.length > 0) {
          throw new Error(
            `port ${input.port} is already in use by pid ${holders.join(", ")} — stop it first`,
          );
        }
      }

      const entry: Entry = { info, child: undefined, logs: [], listeners: new Set() };
      entries.set(id, entry);
      trim();

      // The clock the readiness report is measured against: the moment the
      // command was asked to run, not the moment the wait started. "Ready in
      // 951ms" has to mean the same thing to every reader.
      const beganAt = Date.now();

      let child: Subprocess<"ignore", "pipe", "pipe">;
      try {
        // On Windows the command runs inside a job object, under a supervisor
        // that holds the job handle. Stopping the supervisor then stops the
        // tree — the shell, the runtime and everything the runtime started —
        // without anyone having to walk a tree that is already coming apart.
        const commandArgv = argv(command);
        const plan = jobPlan(command, input.cwd, resolveSupervisorPath());
        const env = childEnv();
        let file: string;
        let args: string[];
        if (plan) {
          file = plan.file;
          args = plan.args;
          Object.assign(env, plan.env);
        } else {
          file = commandArgv[0]!;
          args = commandArgv.slice(1);
        }
        child = bunSpawn([file, ...args], spawnOptions(input.cwd, env));
      } catch (e) {
        info.error = e instanceof Error ? e.message : String(e);
        settle(entry, null);
        return info;
      }

      entry.child = child;
      info.pid = child.pid;
      // Recorded before the first line of output: a crash between here and the
      // next write would otherwise leave a pid nobody knows about.
      persist();

      // Both pipes are read for as long as the process lives. A dev server that
      // writes a lot and has nobody draining it blocks on its own stdout.
      void read(entry, "out", child.stdout as ReadableStream<Uint8Array>);
      void read(entry, "err", child.stderr as ReadableStream<Uint8Array>);

      void child.exited.then((code) => settle(entry, code)).catch(() => settle(entry, null));

      // Wait for the port, not for a stopwatch.
      //
      // A caller that needs the server up has only one honest way to know: try
      // to reach it. `Start-Sleep 7; curl` is the same idea with a guess in place
      // of a check, and it is either too long or too short every time.
      //
      // The two waits are one wait. A command that has not spoken yet has
      // neither proved it is up nor said which port it serves, and the
      // supervisor needs a moment to come up before the command runs at all —
      // so a window shorter than that reports a command that has already
      // failed as one that is running. The wait ends when the port answers,
      // when the command dies, or when the command goes quiet: silence is
      // what a watcher says when it is not going to announce anything.
      //
      // A command that fails at once says so and then exits, so the first
      // thing it says is waited for with a moment's grace. The failure
      // belongs in this answer, not in a later surprise.
      if (info.exit_code === null) {
        info.ready = "unknown";
        const named = input.port !== undefined;
        if (named) info.port = input.port;
        const budget = input.waitMs ?? (named ? DEFAULT_WAIT_MS : ANNOUNCE_WINDOW_MS);
        const deadline = Date.now() + budget;
        // A named port gets the whole budget to answer. A port that was
        // announced was already listening, so it gets a short grace period.
        let acceptUntil = named ? deadline : undefined;
        let spoken = false;
        while (info.exit_code === null && Date.now() < deadline) {
          if (!spoken && entry.logs.length > 0) {
            spoken = true;
            const end = Date.now() + 250;
            while (info.exit_code === null && Date.now() < end) {
              await new Promise((resolve) => setTimeout(resolve, 25));
            }
          }
          if (info.port !== undefined) {
            if (acceptUntil === undefined) acceptUntil = Date.now() + ANNOUNCED_WAIT_MS;
            if (Date.now() > acceptUntil) break;
            if (await portAccepts(info.port)) {
              info.ready = "yes";
              info.ready_ms = Date.now() - beganAt;
              break;
            }
          } else if (quiet(entry, beganAt)) {
            // A command that has said nothing for a moment is not about to
            // announce a port.
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        // A port that never opened is not a failure: the command may still be
        // compiling, or listening somewhere it has not printed yet.
        if (info.port !== undefined && info.ready !== "yes") info.ready = "no";
      }

      // The command has had its chance to say so. A failure it reported
      // belongs in the answer the caller is holding.
      if (info.exit_code !== null && info.exit_code !== 0 && !info.stopped) {
        const tail = entry.logs.slice(-3).map((line) => line.text).join("\n");
        info.error = tail.length > 0 ? tail : `exited with ${info.exit_code}`;
      }

      emit({ type: "dev.started", session_id: info.session_id, process: info });
      return info;
    },

    list(sessionID) {
      const all = [...entries.values()].map((entry) => entry.info);
      const filtered = sessionID === undefined ? all : all.filter((info) => info.session_id === sessionID);
      return filtered.sort((a, b) => b.started_at - a.started_at);
    },

    get(id) {
      return entries.get(id)?.info;
    },

    logs(id, tail = 200) {
      const entry = entries.get(id);
      if (!entry) return [];
      return tail > 0 ? entry.logs.slice(-tail) : entry.logs;
    },

    async stop(id) {
      const entry = entries.get(id);
      if (!entry) return { stopped: false, clean: false, residual: [] };
      return stopEntry(entry);
    },

    async stopSession(sessionID) {
      const owned = [...entries.values()].filter(
        (entry) => entry.info.session_id === sessionID && entry.info.exit_code === null,
      );
      await Promise.all(owned.map((entry) => stopEntry(entry)));
      return owned.length;
    },

    async stopAll() {
      const running = [...entries.values()].filter((entry) => entry.info.exit_code === null);
      await Promise.all(running.map((entry) => stopEntry(entry)));
    },

    /**
     * What the last run left behind, and what is done about it.
     *
     * The file is read at startup because it is the only thing that outlives
     * a service that was killed outright. A command that was still running
     * when that happened is an orphan: nobody is going to stop it, and it
     * holds a port the next command will want.
     *
     * Killing it is not as simple as signalling the pid, because the pid may
     * have been handed to something else in the meantime. The record carries
     * when the command started, and a pid that started later than the record
     * is a different process entirely — that one is left alone.
     */
    async reapStale(): Promise<number> {
      if (!options.pidFile) return 0;
      const records = readRecords(options.pidFile);
      let killed = 0;
      for (const record of records) {
        // A command that was already stopped is history, not work: it is kept
        // in the table so the next reader can still ask what happened.
        if (record.state !== "running") {
          keepRestored(record);
          continue;
        }
        const pid = record.pid;
        const running = pid !== undefined && alive(pid);
        // A pid that is alive is not enough: the number may have been handed
        // to something else since the record was written. Killing that would
        // take a tree nobody here started with it.
        const ours = running && stillOurs(record);
        if (ours) {
          // The root is a supervisor holding a job object: killing it closes
          // the job and the operating system takes the tree with it.
          killTree(pid!);
          record.state = "orphaned";
          record.exit_code = record.exit_code ?? 1;
          killed += 1;
        } else {
          // The command is gone. Either it finished on its own, or the
          // number it had belongs to something else now — and that something
          // else is none of this table's business.
          record.state = "lost";
          record.exit_code = record.exit_code ?? 1;
        }
        const info = keepRestored(record);
        // A reader that cached this row has no other way to learn it is gone;
        // tell the bus the same way a natural exit would.
        emit({ type: "dev.exited", session_id: record.session_id, process: info });
      }
      // A kill is a request; the port going quiet is the fact. A command that
      // starts before the previous run's server has let go of its port is
      // handed a failure that looks like the caller's fault.
      cleanup = settleOrphans(records);
      await cleanup;
      persist();
      return killed;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The file a command names, for the "did you mean the script next to it" case. */
export function commandName(command: string): string {
  const text = command.trim();
  // A quoted first token is a path with spaces in it, and the quotes are the
  // only thing that says where it ends. Splitting on whitespace first would
  // return the middle of the path instead of the binary.
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0]!;
    const end = text.indexOf(quote, 1);
    const quoted = end > 0 ? text.slice(1, end) : text.slice(1);
    return basename(quoted);
  }
  const first = text.split(/\s+/)[0] ?? "";
  return basename(first);
}

/** A command that is plausibly meant to stay up, and so belongs here. */
export function looksLongRunning(command: string): boolean {
  const text = command.toLowerCase();
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b/.test(text)) return true;
  if (/\b(vite|next\s+dev|nuxt\s+dev|nodemon|webpack\s+serve)\b/.test(text)) return true;
  // `./gradlew` starts with a path separator, so the leading word boundary
  // before `gradlew` never matches. Name the wrapper without one.
  if (/(^|[\s;&|])(\.\/)?(mvn|gradlew|gradle)(\s|$)/.test(text) && /\b(spring-boot:run|bootrun|run)\b/.test(text))
    return true;
  if (/\b(uvicorn|gunicorn|flask\s+run|manage\.py\s+runserver)\b/.test(text)) return true;
  if (/\b(dotnet\s+(run|watch))\b/.test(text)) return true;
  if (/\b(cargo\s+(run|watch))\b/.test(text)) return true;
  if (/\bgo\s+run\b/.test(text)) return true;
  if (/\b(rails\s+server|php\s+artisan\s+serve)\b/.test(text)) return true;
  return false;
}

/** A path that exists, so a caller can tell "wrong directory" from "wrong command". */
export function existingDirectory(path: string): boolean {
  return existsSync(path) && isDirectory(path);
}
