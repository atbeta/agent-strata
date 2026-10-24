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
import { basename } from "node:path";

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
}

/** Bounded per-process output. A dev server that runs for hours must not grow without limit. */
const MAX_LOG_LINES = 2000;
/** Bounded process table. Sessions that end take their processes with them. */
const MAX_PROCESSES = 32;

/** How long a start waits for the process to prove it is still alive. */
const LIVENESS_MS = 400;

interface Entry {
  info: DevProcess;
  child: Subprocess<"ignore", "pipe", "pipe"> | undefined;
  logs: DevLogLine[];
  listeners: Set<(line: DevLogLine) => void>;
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
  stop(id: string): Promise<boolean>;
  /** Every process a session owns, stopped together. Called when a session goes away. */
  stopSession(sessionID: string): Promise<number>;
  stopAll(): Promise<void>;
  /** Kill what a previous run left behind. Called once, at startup. */
  reapStale(): number;
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
function argv(command: string): string[] {
  if (process.platform === "win32") return ["cmd", "/C", command];
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

export function createDevManager(options: DevManagerOptions = {}): DevManager {
  const entries = new Map<string, Entry>();
  const listeners = new Set<(event: DevEvent) => void>();

  /** The pids a crash would leave behind, kept on disk as they change. */
  const persist = () => {
    if (!options.pidFile) return;
    const live = [...entries.values()]
      .filter((entry) => entry.info.exit_code === null && entry.info.pid !== undefined)
      .map((entry) => ({ pid: entry.info.pid, id: entry.info.id, command: entry.info.command }));
    try {
      writeFileSync(options.pidFile, JSON.stringify(live));
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
    emit({ type: "dev.output", session_id: entry.info.session_id, process_id: entry.info.id, line });
  };

  const read = async (entry: Entry, stream: "out" | "err", source: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for await (const chunk of source) {
        pending += decoder.decode(chunk, { stream: true });
        let index = pending.indexOf("\n");
        while (index >= 0) {
          const text = pending.slice(0, index).replace(/\r$/, "");
          pending = pending.slice(index + 1);
          if (text.trim().length > 0) push(entry, stream, text);
          index = pending.indexOf("\n");
        }
      }
      const rest = pending.trim();
      if (rest.length > 0) push(entry, stream, rest);
    } catch {
      // The pipe closing under us is how a killed process looks from here.
    }
  };

  const settle = (entry: Entry, code: number | null) => {
    if (entry.info.exit_code !== null) return;
    entry.info.exit_code = code ?? 0;
    entry.child = undefined;
    persist();
    emit({ type: "dev.exited", session_id: entry.info.session_id, process: entry.info });
  };

  const stopEntry = async (entry: Entry) => {
    entry.info.stopped = true;
    const child = entry.child;
    if (!child) {
      // A spawn that never produced a pid has nothing to signal.
      if (entry.info.exit_code === null) settle(entry, null);
      return;
    }
    // The shell exits before the programs it started do, so killing the pid is
    // not killing the tree. A dev server is a shell that runs a script that
    // runs a runtime, and it is the runtime that holds the port.
    if (entry.info.pid !== undefined) {
      killTree(entry.info.pid);
    }
    try {
      child.kill();
    } catch {
      // Already gone; the exit handler settles it.
    }
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

  return {
    async start(input) {
      const command = input.command.trim();
      if (command.length === 0) throw new Error("command is required");
      if (!isDirectory(input.cwd)) throw new Error(`not a directory: ${input.cwd}`);

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
      };
      const entry: Entry = { info, child: undefined, logs: [], listeners: new Set() };
      entries.set(id, entry);
      trim();

      let child: Subprocess<"ignore", "pipe", "pipe">;
      try {
        child = bunSpawn(argv(command), spawnOptions(input.cwd, childEnv()));
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

      // Give a command that dies immediately the chance to say so, so the caller
      // gets "npm: command not found" instead of a process id that is already dead.
      await Promise.race([
        child.exited.then(() => undefined),
        new Promise((resolve) => setTimeout(resolve, LIVENESS_MS)),
      ]);

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
      if (!entry) return false;
      await stopEntry(entry);
      return true;
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

    reapStale() {
      if (!options.pidFile) return 0;
      let raw: string;
      try {
        raw = readFileSync(options.pidFile, "utf8");
      } catch {
        return 0;
      }
      let stale: { pid?: number }[];
      try {
        const parsed: unknown = JSON.parse(raw);
        stale = Array.isArray(parsed) ? parsed : [];
      } catch {
        stale = [];
      }
      let killed = 0;
      for (const item of stale) {
        const pid = item?.pid;
        if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) continue;
        // A pid on its own is not identity: the process may have exited and the
        // number been handed to something else. Only signal one that is still
        // alive, and only kill it as a tree.
        if (!alive(pid)) continue;
        killTree(pid);
        killed += 1;
      }
      try {
        writeFileSync(options.pidFile, "[]");
      } catch {
        // Nothing to do: the next run reads whatever is there and re-checks liveness.
      }
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
