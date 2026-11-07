import { APP_NAME } from "./app-name";

const SHELL = new Set(["bash", "pwsh", "powershell", "cmd"]);

export type PermissionView =
  | { kind: "command"; command: string }
  /** Paths an ask is about, with the command that would run in them. */
  | { kind: "paths"; paths: string[]; command?: string }
  | { kind: "diff"; path?: string; patch: string }
  | { kind: "url"; url: string }
  | { kind: "json" };

function patterns(input: Record<string, unknown>): string {
  if (!Array.isArray(input.patterns)) return "";
  return input.patterns.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n");
}

function patchOf(input: Record<string, unknown>): string | undefined {
  if (typeof input.diff === "string" && input.diff) return input.diff;
  const filediff = input.filediff;
  if (!filediff || typeof filediff !== "object") return undefined;
  const patch = (filediff as { patch?: unknown }).patch;
  return typeof patch === "string" && patch ? patch : undefined;
}

/**
 * The paths an ask names.
 *
 * Two shapes reach this. A tool that asks about a set of folders sends an
 * array (`directories`, `paths`). A tool that asks about one file sends it as
 * a single field next to its parent (`filepath`, `parentDir`), which is what
 * `external_directory` does — and reading only the arrays left that card as a
 * JSON dump with the path buried inside braces. The file comes first because
 * it is the thing being asked about; the parent is how the reader places it.
 */
function pathList(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (value: unknown) => {
    if (typeof value !== "string" || !value) return;
    if (!out.includes(value)) out.push(value);
  };
  add(input.filepath);
  add(input.filePath);
  for (const key of ["directories", "paths"]) {
    const value = input[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) add(item);
  }
  add(input.parentDir);
  add(input.parent_dir);
  return out;
}

/** The one thing the card should show. Anything unrecognised stays a JSON dump. */
export function permissionView(ask: { tool: string; input: Record<string, unknown> }): PermissionView {
  const input = ask.input ?? {};
  // A diff is the answer for an edit, and its path field must not be mistaken
  // for a folder list: the patch is what the reader is approving.
  if (ask.tool === "edit" || ask.tool === "write") {
    const patch = patchOf(input);
    if (patch) {
      const path =
        typeof input.filepath === "string" ? input.filepath : typeof input.filePath === "string" ? input.filePath : undefined;
      return { kind: "diff", path, patch };
    }
  }
  if (SHELL.has(ask.tool)) {
    const command = typeof input.command === "string" && input.command ? input.command : patterns(input);
    if (command) return { kind: "command", command };
  }
  // Where an ask is about paths, the paths are the ask — even when a command
  // rides along. `external_directory` sends the file it wants to open, its
  // parent, and a probe command; the file is what the reader decides about.
  const paths = pathList(input);
  if (paths.length > 0) {
    const command = typeof input.command === "string" && input.command ? input.command : undefined;
    return { kind: "paths", paths, ...(command ? { command } : {}) };
  }
  // A tool that names a command is showing a command, whichever tool it is.
  // `dev_start` and a plugin's own ask both carry `command` and used to fall
  // through to the JSON dump, which put braces and quotes between the reader
  // and the one line they are being asked to approve.
  if (typeof input.command === "string" && input.command) {
    return { kind: "command", command: input.command };
  }
  if (ask.tool === "webfetch") {
    const url = typeof input.url === "string" && input.url ? input.url : patterns(input);
    if (url) return { kind: "url", url };
  }
  return { kind: "json" };
}

/** `waiting` is how many sessions currently need the user. */
export function windowTitle(waiting: number): string {
  return waiting > 0 ? `(${waiting}) ${APP_NAME}` : APP_NAME;
}
