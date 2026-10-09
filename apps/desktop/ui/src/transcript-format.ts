import type { ToolCallView } from "./api";
import { t, tn } from "./i18n";

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
    return { kind, verb: t("tool.verb.bash"), title: command ? firstLine(command) : call.tool };
  }
  if (kind === "read") {
    return { kind, verb: t("tool.verb.read"), title: path ?? call.tool };
  }
  if (kind === "edit") {
    const verb = call.tool.toLowerCase() === "write" ? t("tool.verb.write") : t("tool.verb.edit");
    return { kind, verb, title: path ?? call.tool };
  }
  if (kind === "search") {
    const verb = call.tool.toLowerCase() === "glob" ? t("tool.verb.glob") : t("tool.verb.search");
    const where = path ? ` ${t("tool.search.in", { path })}` : "";
    return { kind, verb, title: pattern ? `${pattern}${where}` : (path ?? call.tool) };
  }
  if (kind === "web") {
    const verb = call.tool.toLowerCase().includes("search") ? t("tool.verb.search") : t("tool.verb.fetch");
    return { kind, verb, title: url ?? pattern ?? call.tool };
  }
  if (kind === "todo") {
    const todos = input.todos;
    const first =
      Array.isArray(todos) && todos.length > 0 && todos[0] && typeof todos[0] === "object"
        ? field(todos[0] as Record<string, unknown>, ["content", "title"])
        : undefined;
    const count = Array.isArray(todos) ? todos.length : 0;
    return { kind, verb: t("tool.verb.plan"), title: first ?? tn("plan.items", count) };
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

/** Milliseconds and seconds are units: `840ms`, `1.5s`, `12s` in every language. */
export function fmtLatency(ms: number | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms)) return undefined;
  if (ms < 1000) return t("latency.ms", { n: Math.round(ms) });
  const seconds = ms / 1000;
  return seconds < 10
    ? t("latency.s.tenth", { n: seconds.toFixed(1) })
    : t("latency.s", { n: Math.round(seconds) });
}

export function statusLabel(status: ToolCallView["status"]): string | undefined {
  if (status === "pending") return t("status.running");
  if (status === "error") return t("status.failed");
  if (status === "interrupted") return t("status.stopped");
  return undefined;
}

/**
 * The permission sentence, assembled from parts rather than concatenated.
 *
 * English says `Denied by you` — verb, space, actor, preposition. Chinese has
 * no slot to fill and says `你已拒绝` — actor first, verb tight against it. One
 * template cannot serve both word orders, so `permission.by` is a two-slot
 * frame that each language fills its own way and the actor and verb are looked
 * up separately before they meet. The reason behind the decision comes from
 * the backend and is passed through untouched; only the frame is translated.
 */
export function permissionLabel(permission: ToolCallView["permission"]): string | undefined {
  if (!permission) return undefined;
  if (!permission.decision) return t("permission.pending");
  const actor =
    permission.by === "user"
      ? t("permission.actor.you")
      : permission.by === "policy"
        ? t("permission.actor.policy")
        : permission.by === "auto"
          ? t("permission.actor.session")
          : undefined;
  const verb = t(permission.decision === "deny" ? "permission.denied" : "permission.allowed");
  const sentence = actor ? t("permission.by", { verb, actor }) : verb;
  return permission.reason
    ? t("permission.with_reason", { verb: sentence, reason: permission.reason })
    : sentence;
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
