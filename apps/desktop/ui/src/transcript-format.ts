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
 * The model was told to answer with this line alone when the goal is done.
 * A reply that is exactly that line is a seam, not a sentence. Anything
 * around it — an earlier line, a thought, a picture — stays a normal message.
 */
export function goalMetReply(blocks: readonly ContentBlock[]): boolean {
  for (const block of blocks) {
    if (block.type === "text") continue;
    if (block.type === "thinking" && block.text.trim() === "") continue;
    return false;
  }
  const lines = messageText(blocks)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length === 1 && lines[0] === "GOAL MET";
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

export function isLengthStop(reason: string | undefined): boolean {
  return reason === "length" || reason === "max_tokens";
}

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
  // The supervised-process tools are shell work with a different lifetime:
  // they render like the terminal they run in — `$ command` over its output.
  dev_start: "shell",
  dev_logs: "shell",
  dev_stop: "shell",
  dev_list: "shell",
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

/**
 * The mark beside a tool call.
 *
 * Kind is not always enough: glob and grep are both searches, and only the
 * name says whether the picture is a folder of files or a glass over text.
 */
export function toolIcon(
  tool: string,
): "terminal" | "page" | "pencil" | "folder" | "search" | "globe" | "list" | "fork" | "wrench" {
  const kind = toolKind(tool);
  if (kind === "shell") return "terminal";
  if (kind === "read") return "page";
  if (kind === "edit") return "pencil";
  if (kind === "search") return tool.toLowerCase() === "glob" ? "folder" : "search";
  if (kind === "web") return "globe";
  if (kind === "todo") return "list";
  if (kind === "task") return "fork";
  return "wrench";
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
  const processId = field(input, ["process_id"]);

  // The dev_* family renders as shell work but the verb is the action, not
  // "Dev_start": `Start pnpm dev`, `Stop dev_x`, and an empty title where the
  // tool takes no argument.
  const tool = call.tool.toLowerCase();
  if (tool === "dev_start") {
    return { kind, verb: t("tool.verb.dev.start"), title: command ? firstLine(command) : call.tool };
  }
  if (tool === "dev_logs") {
    return { kind, verb: t("tool.verb.dev.logs"), title: processId ?? call.tool };
  }
  if (tool === "dev_stop") {
    return { kind, verb: t("tool.verb.dev.stop"), title: processId ?? call.tool };
  }
  if (tool === "dev_list") {
    return { kind, verb: t("tool.verb.dev.list"), title: "" };
  }

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
  if (call.tool.toLowerCase() === "question") {
    const first = Array.isArray(input.questions) ? input.questions[0] : undefined;
    const title =
      first && typeof first === "object"
        ? field(first as Record<string, unknown>, ["header", "question"])
        : undefined;
    return { kind, verb: t("tool.verb.question"), title: title ?? "" };
  }
  const description = field(input, ["description", "prompt", "title"]);
  // An unknown tool still gets the leading capital the named verbs carry.
  const verb = call.tool ? call.tool[0]!.toUpperCase() + call.tool.slice(1) : "";
  return { kind, verb, title: description ?? path ?? command ?? pattern ?? "" };
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
 * Keep the end of a line, within a width the reader can see.
 *
 * The collapsed thought follows whatever was just written. Cutting from the
 * start froze the row on the opening words once they filled it, so a long
 * thought looked stopped. Counting characters gave a Chinese line half the
 * room of an English one — a CJK glyph is about twice as wide — and the cut
 * prefers a word boundary close to where the window opens, because a preview
 * starting mid-token (`…riginal message`) reads as a corrupted string. The
 * backstop keeps that snap from walking so far forward that the line says
 * less than it had room for.
 */
function clipTail(line: string, columns: number): string {
  let width = 0;
  let start = 0;
  for (let i = line.length - 1; i >= 0; i--) {
    width += WIDE.test(line[i]!) ? 2 : 1;
    if (width > columns) {
      start = i + 1;
      break;
    }
  }
  if (start === 0) return line;
  const backstop = start + Math.floor(columns / 4);
  const space = line.indexOf(" ", start);
  const from = space !== -1 && space <= backstop ? space + 1 : start;
  return `…${line.slice(from).trimStart()}`;
}

/** The latest line of a thought, trimmed to the row. Empty when there is nothing to show. */
export function thinkingPreview(text: string): string {
  const lines = text.split("\n");
  let last = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.replace(/[ \t]+/g, " ").trim();
    if (line) {
      last = line;
      break;
    }
  }
  if (!last) return "";
  return clipTail(last, 88);
}

/** A backend clock small enough to be a fixture, not an instant. */
const REAL_INSTANT_MS = 1_000_000_000_000;

/**
 * How long a finished thought ran, on the same scale as a tool's latency.
 *
 * Only a span the backend itself reported counts: both stamps, both real
 * instants, end not before start. A clock we saw ticking locally is an
 * estimate the client made up — it answers nothing, so it shows nothing.
 */
export function thinkingDuration(startedMs?: number, endedMs?: number): string | undefined {
  if (startedMs == null || endedMs == null) return undefined;
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs)) return undefined;
  if (startedMs < REAL_INSTANT_MS || endedMs < REAL_INSTANT_MS) return undefined;
  if (endedMs < startedMs) return undefined;
  return fmtLatency(endedMs - startedMs);
}

/** Milliseconds and seconds are units: `840ms`, `1.5s`, `12s`, `2m 05s`, `10h 15m` in every language. */
export function fmtLatency(ms: number | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms)) return undefined;
  if (ms < 1000) return t("latency.ms", { n: Math.round(ms) });
  const seconds = ms / 1000;
  if (seconds < 10) return t("latency.s.tenth", { n: seconds.toFixed(1) });
  if (seconds < 60) return t("latency.s", { n: Math.round(seconds) });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return t("latency.m", { m: minutes, s: String(Math.floor(seconds % 60)).padStart(2, "0") });
  return t("latency.h", { h: Math.floor(minutes / 60), m: String(minutes % 60).padStart(2, "0") });
}

/**
 * How long a still-running call has been running, for the status beside its
 * row. `fromIso` is the event's timestamp; `now` is the caller's clock. An
 * unparsable stamp is no answer (`undefined`), and a clock slightly ahead of
 * the event's reads as zero rather than a negative second. Under a minute the
 * figure ticks in whole seconds — `9s`, not `9.0s`, because a number that is
 * meant to change every second should not lie about its precision — past it
 * the string is latency's own.
 */
export function fmtElapsed(fromIso: string, now: number): string | undefined {
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return undefined;
  const ms = Math.max(0, now - from);
  if (ms < 60_000) return t("latency.s", { n: Math.floor(ms / 1000) });
  return fmtLatency(ms);
}

/**
 * A call whose "latency" is the reader deciding, not the tool running. The
 * number beside such a row measures how long a person took to answer, which
 * is not a speed anybody tuned.
 */
export function isInteractiveTool(tool: string): boolean {
  return ["question", "ask", "askuserquestion", "ask_user_question"].includes(tool.toLowerCase());
}

export function statusLabel(status: ToolCallView["status"]): string | undefined {
  if (status === "pending") return t("status.running");
  if (status === "error") return t("status.failed");
  if (status === "interrupted") return t("status.stopped");
  return undefined;
}

/**
 * The word a tool row carries on its right, and how loud it speaks. `pending`
 * is the backend's word for "no result yet" — it stays `pending` forever in a
 * session whose run died mid-call, so it only reads as running while the
 * session is actually live (`live`). An orphaned pending call is unfinished
 * work, not work in progress: muted, no ticker, and a parked permission
 * prompt says the same thing — it never got its answer either.
 */
export function toolStatusLabel(
  call: Pick<ToolCallView, "status" | "permission">,
  live: boolean,
): { text: string; tone: "live" | "muted" | "danger" } | undefined {
  if (call.permission?.decision === "deny") return { text: t("tool.status.denied"), tone: "danger" };
  if (call.status === "pending") {
    if (!live) return { text: t("status.unfinished"), tone: "muted" };
    if (call.permission && !call.permission.decision)
      return { text: t("tool.status.needs_permission"), tone: "live" };
    return { text: t("status.running"), tone: "live" };
  }
  const text = statusLabel(call.status);
  if (text === undefined) return undefined;
  return { text, tone: call.status === "error" ? "danger" : "muted" };
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
