import { spawn as bunSpawn } from "bun";
import type { PtyProcess, PtySignal, PtySpawn, PtyTerminate, TerminalSignal } from "./types";

export const spawnPty: PtySpawn = (input) => {
  const child = bunSpawn(input.argv, {
    cwd: input.cwd,
    env: input.env,
    detached: input.detached,
    windowsHide: true,
    terminal: {
      cols: input.cols,
      rows: input.rows,
      data: (_terminal, data) => input.onData(data),
    },
  });
  if (!child.terminal) throw new Error("could not allocate a pseudo-terminal");
  return child as PtyProcess;
};

export const signalPty: PtySignal = async (child, signal, platform) => {
  if (platform === "win32") {
    if (signal !== "SIGINT") throw new Error(`${signal} is not supported for Windows terminals`);
    child.terminal.write("\x03");
    return;
  }
  const group = await foregroundProcessGroup(child);
  if (group === child.pid) {
    throw new Error("the signal would reach the shell itself; use terminal_close to end the terminal");
  }
  process.kill(-group, signal);
};

async function foregroundProcessGroup(child: PtyProcess): Promise<number> {
  const tty = (await ps(["-p", String(child.pid), "-o", "tty="])).trim();
  if (!tty || tty === "??" || tty === "?") throw new Error("could not find the terminal's foreground process group");
  const rows = (await ps(["-t", tty, "-o", "tpgid="])).trim().split(/\s+/);
  const group = Number(rows[0]);
  if (!Number.isSafeInteger(group) || group <= 0) {
    throw new Error("could not find the terminal's foreground process group");
  }
  return group;
}

async function ps(args: string[]): Promise<string> {
  const child = bunSpawn(["ps", ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (code !== 0) throw new Error("could not inspect the terminal's foreground process group");
  return output;
}

export const terminatePty: PtyTerminate = async (child, platform) => {
  if (platform === "win32") {
    try {
      child.kill();
    } catch {}
    try {
      const taskkill = bunSpawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      });
      await taskkill.exited;
    } catch {}
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
  const exited = await Promise.race([
    child.exited.then(() => true).catch(() => true),
    Bun.sleep(1000).then(() => false),
  ]);
  try {
    child.terminal.close();
  } catch {}
  return exited ? "exited" : "unconfirmed";
};

export type { TerminalSignal };
