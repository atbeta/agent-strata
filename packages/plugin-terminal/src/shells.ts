import { accessSync, constants, existsSync } from "node:fs";
import type { PtyShell } from "./types";

export function listShells(platform: NodeJS.Platform = process.platform): PtyShell[] {
  if (platform === "win32") return windowsShells();
  const names = new Set<string>();
  const preferred = process.env.SHELL?.split("/").pop();
  if (preferred) names.add(preferred);
  for (const name of ["zsh", "bash", "fish", "sh"]) names.add(name);
  const out: PtyShell[] = [];
  for (const name of names) {
    const path = preferred === name && process.env.SHELL ? process.env.SHELL : Bun.which(name);
    if (!path || !executable(path)) continue;
    out.push({ name, path, acceptable: true });
  }
  return out;
}

function windowsShells(): PtyShell[] {
  const candidates = [
    { name: "pwsh", path: Bun.which("pwsh") },
    { name: "powershell", path: Bun.which("powershell") },
    { name: "cmd", path: process.env.COMSPEC || Bun.which("cmd.exe") },
  ];
  return candidates.flatMap((shell) =>
    shell.path ? [{ name: shell.name, path: shell.path, acceptable: true }] : [],
  );
}

function executable(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function shellByName(shells: PtyShell[], name: unknown): PtyShell | undefined {
  if (name === undefined || name === "") return shells[0];
  if (typeof name !== "string") return undefined;
  return shells.find((shell) => shell.name === name && shell.acceptable && shell.path.length > 0);
}

export function shellArgv(
  shell: PtyShell,
  command?: string,
  platform: NodeJS.Platform = process.platform,
  options: { profile?: boolean } = {},
): string[] {
  if (command !== undefined) {
    if (platform === "win32") {
      if (shell.name === "cmd") return [shell.path, "/d", "/s", "/c", command];
      return [shell.path, "-NoLogo", "-NoProfile", "-Command", command];
    }
    if (options.profile === false) {
      if (shell.name === "zsh") return [shell.path, "-f", "-c", command];
      if (shell.name === "bash") return [shell.path, "--noprofile", "--norc", "-c", command];
      if (shell.name === "fish") return [shell.path, "--no-config", "-c", command];
    }
    return [shell.path, "-c", command];
  }
  if (platform === "win32" && shell.name !== "cmd") return [shell.path, "-NoLogo", "-NoProfile"];
  if (options.profile === false) {
    if (shell.name === "zsh") return [shell.path, "-f"];
    if (shell.name === "bash") return [shell.path, "--noprofile", "--norc"];
    if (shell.name === "fish") return [shell.path, "--no-config"];
  }
  return [shell.path];
}

export function terminalTitle(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new Error("invalid title");
  const title = value.replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40);
  return title || undefined;
}

export function terminalSize(rows: unknown, cols: unknown): { rows: number; cols: number } {
  if (
    typeof rows !== "number" ||
    typeof cols !== "number" ||
    !Number.isInteger(rows) ||
    !Number.isInteger(cols) ||
    rows < 1 ||
    rows > 400 ||
    cols < 1 ||
    cols > 500
  ) {
    throw new Error("invalid size");
  }
  return { rows, cols };
}

export function terminalEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of [
    "STRATA_PORT",
    "STRATA_DESKTOP_DIR",
    "STRATA_API_TOKEN",
    "STRATA_SERVICE_URL",
    "STRATA_OPENCODE_URL",
    "STRATA_OPENCODE_USERNAME",
    "STRATA_OPENCODE_PASSWORD",
    "STRATA_DEV_JOB_PAYLOAD",
  ]) {
    delete env[key];
  }
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}
