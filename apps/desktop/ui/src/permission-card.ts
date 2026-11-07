import { APP_NAME } from "./app-name";

const SHELL = new Set(["bash", "pwsh", "powershell", "cmd"]);

export type PermissionView =
  | { kind: "command"; command: string }
  /** Folders an ask is about, with the command that would run in them. */
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

/** A list of paths an ask names, when it names them as an array. */
function pathList(input: Record<string, unknown>): string[] {
  for (const key of ["directories", "paths"]) {
    const value = input[key];
    if (!Array.isArray(value)) continue;
    const out = value.filter((p): p is string => typeof p === "string" && p.length > 0);
    if (out.length > 0) return out;
  }
  return [];
}

/** The one thing the card should show. Anything unrecognised stays a JSON dump. */
export function permissionView(ask: { tool: string; input: Record<string, unknown> }): PermissionView {
  const input = ask.input ?? {};
  const paths = pathList(input);
  // An ask about where a command may run is about the folders first: the tool
  // may send an unrelated command alongside them (`external_directory` sends a
  // probe of the environment), and that must not hide the answer.
  if (paths.length > 0 && !SHELL.has(ask.tool)) {
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
  if (SHELL.has(ask.tool)) {
    const command = patterns(input);
    if (command) return { kind: "command", command };
  }
  if (ask.tool === "edit" || ask.tool === "write") {
    const patch = patchOf(input);
    if (patch) {
      const path =
        typeof input.filepath === "string" ? input.filepath : typeof input.filePath === "string" ? input.filePath : undefined;
      return { kind: "diff", path, patch };
    }
  }
  if (ask.tool === "webfetch") {
    const url = typeof input.url === "string" && input.url ? input.url : patterns(input);
    if (url) return { kind: "url", url };
  }
  // An ask about where a command may run is a list of folders, not a document.
  // A shell tool's own ask is already the command above, so only a tool that
  // names folders reaches this.
  if (paths.length > 0) return { kind: "paths", paths };
  return { kind: "json" };
}

/** `waiting` is how many sessions currently need the user. */
export function windowTitle(waiting: number): string {
  return waiting > 0 ? `(${waiting}) ${APP_NAME}` : APP_NAME;
}
