import type { McpServerStatus } from "./api";

export type McpAttention = "error" | "pending";
export type McpRowAction = "connect" | "disconnect" | "auth";
export type McpFollowUp = "auth" | "stay";
export type McpAddKind = "command" | "url";
export type McpAddProblem = "name" | "command" | "url";

const NAME = /^[\w][\w.-]{0,63}$/;

/** A header dot. Failure wins over sign-in, and a healthy list has none. */
export function mcpAttention(statuses: readonly McpServerStatus["status"][]): McpAttention | undefined {
  if (statuses.some((status) => status === "failed" || status === "needs_client_registration")) return "error";
  if (statuses.some((status) => status === "needs_auth")) return "pending";
  return undefined;
}

/** The single control a row is allowed to show. Registration has none. */
export function mcpRowAction(status: McpServerStatus["status"]): McpRowAction | undefined {
  if (status === "connected") return "disconnect";
  if (status === "disabled" || status === "failed") return "connect";
  if (status === "needs_auth") return "auth";
  return undefined;
}

/**
 * After connect, sign-in opens on that row. Every other outcome is already
 * written in the status word, so the row does not grow a second sentence.
 */
export function mcpFollowUp(
  action: "connect" | "disconnect",
  after: McpServerStatus["status"] | undefined,
): McpFollowUp {
  if (action === "connect" && after === "needs_auth") return "auth";
  return "stay";
}

/**
 * One problem, or nothing. An empty field stays quiet. A short address prefix
 * stays quiet too, until it has a scheme, a space, or enough characters to be
 * a finished value.
 */
export function mcpAddProblem(kind: McpAddKind, name: string, value: string): McpAddProblem | undefined {
  const trimmedName = name.trim();
  if (trimmedName && (!NAME.test(trimmedName) || trimmedName.includes(".."))) return "name";
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (kind === "command") return commandProblem(trimmed) ? "command" : undefined;
  return urlProblem(trimmed) ? "url" : undefined;
}

/** The first paint, before any list has arrived. */
export function mcpShowLoading(ready: boolean, serverCount: number): boolean {
  return !ready && serverCount === 0;
}

/** No servers: the form is the panel. Otherwise it waits for the add control. */
export function mcpShowAddForm(ready: boolean, serverCount: number, addOpen: boolean): boolean {
  if (!ready && serverCount === 0) return false;
  return serverCount === 0 || addOpen;
}

function commandProblem(input: string): boolean {
  if (input.length > 2000) return true;
  const out: string[] = [];
  let cur = "";
  let quote = false;
  for (const ch of input) {
    if (quote) {
      if (ch === '"') quote = false;
      else cur += ch;
      continue;
    }
    if (ch === '"') {
      quote = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (!cur) continue;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quote) return true;
  if (cur) out.push(cur);
  if (out.length === 0 || out.length > 16) return true;
  return out.some((part) => part.length > 400);
}

function urlProblem(input: string): boolean {
  if (!input.includes(":") && !/\s/.test(input) && input.length < 12) return false;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return true;
  }
  return url.protocol !== "http:" && url.protocol !== "https:";
}
