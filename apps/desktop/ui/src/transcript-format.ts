import type { ContentBlock, ToolCallView } from "./api";
import { t, tn } from "./i18n";

/**
 * Whether the message carries anything worth showing at all. Text/thinking
 * must be non-blank; images and file refs always render something visible.
 * Rows that fail this (e.g. a tool-call-only carrier) emit no element.
 */
export function hasMessageContent(blocks: readonly ContentBlock[]): boolean {
  return blocks.some((block) =>
    block.type === "text" || block.type === "thinking" ? block.text.trim() !== "" : true,
  );
}

/** Text blocks only, joined by newline — the copyable public text of a message. */
export function messageText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Cancellation arrives as a plain error string. Only the exact backend wordings
 * map to the neutral "stopped" notice — a message that merely mentions aborting
 * is a real error and must not be downgraded.
 */
const STOPPED_ERRORS = new Set([
  "aborted",
  "aborterror",
  "messageabortederror",
  "the operation was aborted",
  "the operation was aborted.",
]);

export function assistantNotice(
  error: string | undefined,
): { kind: "stopped" | "error"; text: string } | undefined {
  const trimmed = error?.trim();
  if (!trimmed) return undefined;
  if (STOPPED_ERRORS.has(trimmed.toLowerCase())) {
    return { kind: "stopped", text: t("transcript.stopped") };
  }
  return { kind: "error", text: error! };
}

export type ToolKind = "shell" | "read" | "edit" | "search" | "web" | "todo" | "task" | "generic";

const KINDS: Record<string, ToolKind> = {
  bash: "shell",
  shell: "shell",
  exec: "shell",
  execute: "shell",
  read: "read",
  view: "read",
  edit: "edit",
  write: "edit",
  apply_patch: "edit",
  multiedit: "edit",
  strreplace: "edit",
  delete: "edit",
  move: "edit",
  grep: "search",
  glob: "search",
  search: "search",
  webfetch: "web",
  websearch: "web",
  fetch: "web",
  todowrite: "todo",
  todoread: "todo",
  task: "task",
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
  if (kind === "task") {
    return {
      kind,
      verb: t("tool.verb.task"),
      title: field(input, ["description", "subagent_type", "agent"]) ?? call.tool,
    };
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

/** Columns a full-width glyph occupies against a Latin one. */
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/**
 * Cut to a width the reader can see, not to a character count.
 *
 * Counting characters gave a Chinese preview half the room of an English one —
 * a CJK glyph is about twice as wide — and Chinese is the language where a
 * short preview hurts most. Cutting also prefers a word boundary, because a
 * preview ending mid-token (`git log --oneline "origi…`) reads as a corrupted
 * string rather than a clipped one. The backstop keeps the break from marching
 * so far left that the preview says less than it had room for.
 */
function clipToWidth(line: string, columns: number): string {
  let width = 0;
  let cut = line.length;
  for (let i = 0; i < line.length; i++) {
    width += WIDE.test(line[i]) ? 2 : 1;
    if (width > columns) {
      cut = i;
      break;
    }
  }
  if (cut === line.length) return line;
  const backstop = cut - Math.floor(columns / 4);
  const space = line.lastIndexOf(" ", cut);
  return `${(space > backstop ? line.slice(0, space) : line.slice(0, cut)).trimEnd()}…`;
}

export function thinkingPreview(text: string): string {
  return clipToWidth(text.replace(/\s+/g, " ").trim(), 88);
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
