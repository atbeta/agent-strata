import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export type EditorId = "cursor" | "vscode";

const CLI: Record<EditorId, string> = {
  cursor: "cursor",
  vscode: "code",
};

const WINDOWS_EXE: Record<EditorId, string> = {
  cursor: "Cursor.exe",
  vscode: "Code.exe",
};

const MAC_APP: Record<EditorId, string> = {
  cursor: "Cursor.app",
  vscode: "Visual Studio Code.app",
};

export interface EditorLookup {
  which(name: string): string | undefined;
  exists(path: string): boolean;
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
}

/** The launcher and the file it may open. Anything else is refused. */
export function editorLaunch(editor: unknown, file: unknown): { bin: string; file: string } | { error: string } {
  if (editor !== "cursor" && editor !== "vscode") return { error: "editor must be cursor or vscode" };
  if (typeof file !== "string" || file.includes("\0") || !isAbsolute(file)) return { error: "path must be absolute" };
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return { error: "path is not a file" };
  } catch {
    return { error: "path is not a file" };
  }
  return { bin: CLI[editor], file };
}

/**
 * The process that should actually start.
 *
 * On Windows `code` is `code.cmd`. Starting that from a GUI process allocates
 * a console, so a black window flashes and only then does VS Code appear.
 * The editor itself is `Code.exe` one directory up; launching that opens the
 * file with no console. The same layout holds for Cursor.
 *
 * A missing command is not the same as a missing editor: the app can be
 * installed without its shell command on PATH. The usual install folders are
 * checked before giving up. When none of them exist, the code is
 * `vscode-missing` or `cursor-missing` so the reader gets a translated line
 * instead of a raw English sentence.
 */
export function editorCommand(
  editor: unknown,
  file: unknown,
  lookup: EditorLookup,
): { cmd: string[] } | { error: string; code?: string } {
  const checked = editorLaunch(editor, file);
  if ("error" in checked) return checked;
  const id = editor as EditorId;
  const argv = resolveEditor(id, lookup);
  if (!argv) {
    const name = id === "vscode" ? "VS Code" : "Cursor";
    return { error: `${name} is not installed`, code: `${id}-missing` };
  }
  return { cmd: [...argv, checked.file] };
}

function resolveEditor(id: EditorId, lookup: EditorLookup): string[] | undefined {
  const found = lookup.which(CLI[id]);
  if (lookup.platform === "win32") {
    const exe = (found && windowsGui(found, WINDOWS_EXE[id], lookup.exists)) || windowsInstall(id, lookup);
    if (exe) return [exe];
    if (found) return [found];
    return undefined;
  }
  if (found) return [found];
  if (lookup.platform === "darwin") {
    const app = macApp(id, lookup);
    if (!app) return undefined;
    return [lookup.which("open") ?? "open", "-a", app];
  }
  return undefined;
}

function windowsGui(launcher: string, exe: string, exists: (path: string) => boolean): string | undefined {
  const lower = launcher.toLowerCase();
  if (lower.endsWith(".exe")) return exists(launcher) ? launcher : undefined;
  const dir = dirname(launcher);
  for (const candidate of [join(dir, "..", exe), join(dir, exe)]) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

function windowsInstall(id: EditorId, lookup: EditorLookup): string | undefined {
  const exe = WINDOWS_EXE[id];
  const env = lookup.env;
  const roots =
    id === "vscode"
      ? [
          env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Microsoft VS Code"),
          env.ProgramFiles && join(env.ProgramFiles, "Microsoft VS Code"),
          env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Microsoft VS Code"),
        ]
      : [
          env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "cursor"),
          env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Cursor"),
          env.ProgramFiles && join(env.ProgramFiles, "cursor"),
          env.ProgramFiles && join(env.ProgramFiles, "Cursor"),
        ];
  for (const root of roots) {
    if (!root) continue;
    const path = join(root, exe);
    if (lookup.exists(path)) return path;
  }
  return undefined;
}

function macApp(id: EditorId, lookup: EditorLookup): string | undefined {
  const name = MAC_APP[id];
  const home = lookup.env.HOME;
  const candidates = [join("/Applications", name), home ? join(home, "Applications", name) : ""];
  return candidates.find((path) => path && lookup.exists(path));
}
