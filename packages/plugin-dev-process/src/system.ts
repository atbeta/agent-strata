import { spawn as bunSpawn, type Subprocess } from "bun";
import { connect } from "node:net";
import { childEnv, chooseWindowsShell, type WindowsShell } from "./command";
import { jobPlan } from "./dev-process-job";

export type DevChild = Subprocess<"ignore", "pipe", "pipe">;

export interface PortProbe {
  accepts(port: number, timeoutMs?: number): Promise<boolean>;
  holders(port: number): Promise<number[]>;
}

export interface System {
  readonly ports: PortProbe;
  commandShell(): string;
  spawn(command: string, cwd: string): DevChild;
  alive(pid: number): boolean;
  killTree(pid: number): void;
  processStartedAt(pid: number): number | undefined;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

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

export function createPortProbe(platform: NodeJS.Platform = process.platform): PortProbe {
  return {
    accepts: portAccepts,
    holders: (port) => (platform === "win32" ? windowsPortHolders(port) : posixPortHolders(port)),
  };
}

/**
 * The pids still holding a port.
 *
 * Only used when a stop could not prove the port was free: the answer to
 * "what is still on it" is the difference between a clean stop and a stop
 * that has to be reported as a failure.
 */
async function windowsPortHolders(port: number): Promise<number[]> {
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

export function createSystem(platform: NodeJS.Platform = process.platform, ports = createPortProbe(platform)): System {
  let windowsShell: WindowsShell | undefined;

  const resolveWindowsShell = (): WindowsShell => {
    if (windowsShell) return windowsShell;
    windowsShell = chooseWindowsShell({
      pwsh: Bun.which("pwsh"),
      powershell: Bun.which("powershell"),
      comspec: process.env.COMSPEC,
    });
    return windowsShell;
  };

  const commandShell = (): string => {
    if (platform === "win32") return resolveWindowsShell().name;
    return process.env.SHELL || "/bin/sh";
  };

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
  const resolveSupervisorPath = (): string | undefined => {
    if (platform !== "win32") return undefined;
    const shell = resolveWindowsShell();
    return shell.name === "cmd" ? undefined : shell.path;
  };

  const argv = (command: string): string[] => {
    if (platform === "win32") {
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
  };

  return {
    ports,
    commandShell,
    spawn(command, cwd) {
      // On Windows the command runs inside a job object, under a supervisor
      // that holds the job handle. Stopping the supervisor then stops the
      // tree — the shell, the runtime and everything the runtime started —
      // without anyone having to walk a tree that is already coming apart.
      const commandArgv = argv(command);
      const plan = jobPlan(command, cwd, resolveSupervisorPath());
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
      return bunSpawn([file, ...args], {
        cwd,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
        detached: platform !== "win32",
      });
    },
    alive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        // EPERM means the process exists and belongs to someone else. That is not
        // ours to kill, and it is not one of ours either, so treat it as gone.
        return false;
      }
    },
    killTree(pid) {
      if (platform === "win32") {
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
    },
    processStartedAt(pid) {
      if (platform === "win32") {
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
    },
  };
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
export function parseProcessStart(text: string): number | undefined {
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

export const defaultSystem = createSystem();

/** The shell commands run in, for the UI and for the model to read. */
export function commandShell(): string {
  return defaultSystem.commandShell();
}
