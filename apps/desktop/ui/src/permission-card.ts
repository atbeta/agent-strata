import { APP_NAME } from "./app-name";

const SHELL = new Set(["bash", "pwsh", "powershell", "cmd"]);

export type PermissionView =
  | { kind: "command"; command: string }
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

/** The one thing the card should show. Anything unrecognised stays a JSON dump. */
export function permissionView(ask: { tool: string; input: Record<string, unknown> }): PermissionView {
  const input = ask.input ?? {};
  if (SHELL.has(ask.tool)) {
    const command = typeof input.command === "string" && input.command ? input.command : patterns(input);
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
  return { kind: "json" };
}

/** `waiting` is how many sessions currently need the user. */
export function windowTitle(waiting: number): string {
  return waiting > 0 ? `(${waiting}) ${APP_NAME}` : APP_NAME;
}
