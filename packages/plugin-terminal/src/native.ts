import { spawn as bunSpawn } from "bun";
import type { PtyProcess, PtySpawn, PtyTerminate } from "./types";

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

export const terminatePty: PtyTerminate = async (child, platform) => {
  if (platform === "win32") {
    try {
      child.kill();
    } catch {}
    try {
      bunSpawn(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      });
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
  await Promise.race([child.exited.catch(() => 0), Bun.sleep(1000)]);
  try {
    child.terminal.close();
  } catch {}
};
