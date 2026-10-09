import type { ToolCallView } from "./api";

export type ToolKind = "shell" | "read" | "edit" | "search" | "web" | "todo" | "generic";

const KINDS: Record<string, ToolKind> = {
  bash: "shell",
  shell: "shell",
  exec: "shell",
  read: "read",
  view: "read",
  edit: "edit",
  write: "edit",
  apply_patch: "edit",
  multiedit: "edit",
  strreplace: "edit",
  grep: "search",
  glob: "search",
  webfetch: "web",
  websearch: "web",
  fetch: "web",
  todowrite: "todo",
  todoread: "todo",
};

export function toolKind(name: string): ToolKind {
  return KINDS[name.toLowerCase()] ?? "generic";
}

function field(input: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function firstLine(text: string, max = 96): string {
  const line = text.split("\n").find((part) => part.trim())?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export interface ToolHeadline {
  kind: ToolKind;
  verb: string;
  title: string;
}

export function toolHeadline(call: Pick<ToolCallView, "tool" | "input">): ToolHeadline {
  const kind = toolKind(call.tool);
  const input = call.input ?? {};
  const path = field(input, ["filePath", "file_path", "path", "file"]);
  const command = field(input, ["command", "cmd"]);
  const pattern = field(input, ["pattern", "query", "glob"]);
  const url = field(input, ["url", "href"]);

  if (kind === "shell") {
    return { kind, verb: "Bash", title: command ? firstLine(command) : call.tool };
  }
  if (kind === "read") {
    return { kind, verb: "Read", title: path ?? call.tool };
  }
  if (kind === "edit") {
    const verb = call.tool.toLowerCase() === "write" ? "Write" : "Edit";
    return { kind, verb, title: path ?? call.tool };
  }
  if (kind === "search") {
    const verb = call.tool.toLowerCase() === "glob" ? "Glob" : "Search";
    const where = path ? ` in ${path}` : "";
    return { kind, verb, title: pattern ? `${pattern}${where}` : (path ?? call.tool) };
  }
  if (kind === "web") {
    const verb = call.tool.toLowerCase().includes("search") ? "Search" : "Fetch";
    return { kind, verb, title: url ?? pattern ?? call.tool };
  }
  if (kind === "todo") {
    const todos = input.todos;
    const first =
      Array.isArray(todos) && todos.length > 0 && todos[0] && typeof todos[0] === "object"
        ? field(todos[0] as Record<string, unknown>, ["content", "title"])
        : undefined;
    return { kind, verb: "Plan", title: first ?? `${Array.isArray(todos) ? todos.length : 0} items` };
  }
  const description = field(input, ["description", "prompt", "title"]);
  return { kind, verb: call.tool, title: description ?? path ?? command ?? pattern ?? "" };
}

export function isDiff(text: string): boolean {
  let hits = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@") || (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) {
      hits++;
      if (hits >= 2) return true;
    }
  }
  return false;
}

export function diffStat(text: string): { add: number; del: number } | undefined {
  if (!isDiff(text)) return undefined;
  let add = 0;
  let del = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++;
    else if (line.startsWith("-") && !line.startsWith("---")) del++;
  }
  return { add, del };
}

export function thinkingPreview(text: string): string {
  return firstLine(text.replace(/\s+/g, " "), 88);
}

export function fmtLatency(ms: number | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms)) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

export function statusLabel(status: ToolCallView["status"]): string | undefined {
  if (status === "pending") return "Running";
  if (status === "error") return "Failed";
  if (status === "interrupted") return "Stopped";
  return undefined;
}

export function permissionLabel(permission: ToolCallView["permission"]): string | undefined {
  if (!permission) return undefined;
  if (!permission.decision) return "Waiting for permission";
  const who = permission.by === "user" ? "you" : permission.by === "policy" ? "policy" : permission.by === "auto" ? "the session" : undefined;
  const verb = permission.decision === "deny" ? "Denied" : "Allowed";
  const by = who ? ` by ${who}` : "";
  return permission.reason ? `${verb}${by} — ${permission.reason}` : `${verb}${by}`;
}

export interface TodoItem {
  content: string;
  status?: string;
}

export function todoItems(input: Record<string, unknown>): TodoItem[] {
  const todos = input.todos;
  if (!Array.isArray(todos)) return [];
  return todos.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const content = field(item as Record<string, unknown>, ["content", "title"]);
    if (!content) return [];
    const status = (item as { status?: unknown }).status;
    return [{ content, status: typeof status === "string" ? status : undefined }];
  });
}
