import type { ContentBlock, ToolCallView, Turn } from "./api";
import { t, tn } from "./i18n";
import { pluginOfTool, registryVersion, toolRenderer } from "./plugin-registry";

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

/**
 * The copyable public text of a message: its text blocks, and the task
 * statement of a subtask block — for a subagent's opening message that prompt
 * IS the text, and leaving it out would copy nothing.
 */
export function messageText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(
      (b): b is Extract<ContentBlock, { type: "text" | "subtask" }> =>
        b.type === "text" || b.type === "subtask",
    )
    .map((b) => (b.type === "subtask" ? b.prompt : b.text))
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

/**
 * The adapter's word for a reply the run's close cut off mid-write: the
 * message never reported `time.completed`, so it gets no real finish reason —
 * only the mark that it did not get to finish.
 */
export const INTERRUPTED_STOP = "interrupted";

export function isInterruptedStop(reason: string | undefined): boolean {
  return reason === INTERRUPTED_STOP;
}

/**
 * A reply the reader chose to end. Both words mark a write that was cut off;
 * "stopped" just names who did it, so the notice can say so instead of
 * sounding like the session died.
 */
export const STOPPED_STOP = "stopped";

export function isStoppedStop(reason: string | undefined): boolean {
  return reason === STOPPED_STOP;
}

/**
 * Whether the adapter confirmed that a reply was cut off. A partial without a
 * running flag is only a transient view of the stream, not proof of an ended
 * turn; the adapter writes an explicit final when the close is real.
 */
export function replyInterrupted(message: { partial?: boolean; stop_reason?: string }): boolean {
  return isInterruptedStop(message.stop_reason);
}

/**
 * Whether a turn is parked on a child session rather than finished.
 *
 * A task call stays pending until the child returns. While it does, the
 * parent's stream can close provisionally — the adapter writes a soft
 * interrupted final that a real completion replaces later — but calling that
 * reply "cut off" while the child is still writing is a warning the reader
 * did not earn, and it vanishes the moment the child's message lands.
 */
export function waitingOnChild(calls: readonly { tool: string; status: string }[]): boolean {
  return calls.some((call) => call.tool === "task" && call.status === "pending");
}

export type InterruptionNotice = "none" | "interrupted" | "stopped";

/**
 * Whether a reply should carry a cut-off mark.
 *
 * The adapter writes an interrupted final whenever an open message looks quiet.
 * That mark is provisional: the same message id may still be completed and
 * replace it. A reader watching a live session saw the notice flash and then
 * vanish while the work carried on, which is worse than saying nothing.
 *
 * So a mark needs evidence that the reply is not going to continue:
 *  - the session ended, or
 *  - something came after this message, so it is no longer the one still being
 *    written.
 * A tail message in a live session is never evidence — it is the candidate
 * itself.
 *
 * A stop the reader asked for is different: it is a fact the moment it lands,
 * and it names their action, so it does not wait for the session to end.
 */
export function interruptionNotice(
  message: { partial?: boolean; stop_reason?: string },
  state: { live: boolean; waiting: boolean; ended: boolean; tail: boolean },
): InterruptionNotice {
  if (isStoppedStop(message.stop_reason)) return state.live ? "none" : "stopped";
  if (!isInterruptedStop(message.stop_reason)) return "none";
  if (state.live || state.waiting) return "none";
  if (!state.ended && state.tail) return "none";
  return "interrupted";
}

/**
 * A finished reply that came back with nothing to show and nothing to say
 * why. `tool-calls` is exempt — that message's content is its calls, which
 * render in their own rows — and an interrupted reply has its own marker.
 * Without a flag the turn reads as a prompt nobody answered: exactly the
 * failure this exists to name.
 */
export function silentEmptyReply(message: {
  content: readonly ContentBlock[];
  partial?: boolean;
  error?: string;
  structured?: unknown;
  stop_reason?: string;
}): boolean {
  if (message.partial === true) return false;
  if (message.error !== undefined || message.structured !== undefined) return false;
  if (
    message.stop_reason === "tool-calls" ||
    isInterruptedStop(message.stop_reason) ||
    isStoppedStop(message.stop_reason)
  )
    return false;
  return !hasMessageContent(message.content);
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

/**
 * How a tool call should be drawn.
 *
 * A plugin's declaration comes first, then the builtin table, then the generic
 * row — the order the design asks for (§4.7: "插件元数据优先"). What keeps a
 * plugin from repainting a builtin name is not this order but manifest
 * validation: a renderer may only name one of that plugin's *own* tools, and a
 * qualified name is `<plugin>_<tool>` with an id that cannot contain `_`. So
 * the only entries a plugin can reach are the ones it owns — `dev_start`
 * belongs to the `dev` plugin, which is the whole reason it may describe it.
 *
 * Reading `registryVersion()` is what makes this reactive: the registry loads
 * after the first paint, and a renderer that arrives late has to reach rows
 * that are already on screen.
 */
export function toolKind(name: string): ToolKind {
  void registryVersion();
  const declared = toolRenderer(name);
  if (declared) return RENDER_KIND_TO_TOOL_KIND[declared.kind] ?? "generic";
  return KINDS[name.toLowerCase()] ?? "generic";
}

/** A plugin renders in the app's vocabulary, not its own. */
const RENDER_KIND_TO_TOOL_KIND: Record<string, ToolKind> = {
  terminal: "shell",
  web: "web",
  read: "read",
  edit: "edit",
  search: "search",
  todo: "todo",
  task: "task",
  image: "read",
  generic: "generic",
};

/**
 * The mark beside a tool call.
 *
 * Kind is not always enough: glob and grep are both searches, and only the
 * name says whether the picture is a folder of files or a glass over text.
 * And a read whose path is an image is a picture, not a page — the input is
 * what says which.
 */
export type ToolIconName =
  | "terminal"
  | "page"
  | "pencil"
  | "folder"
  | "search"
  | "globe"
  | "list"
  | "fork"
  | "wrench"
  | "image"
  | "message"
  | "code";

export function toolIcon(tool: string, input?: Record<string, unknown>): ToolIconName {
  // A declared icon wins over the kind's default, which is the whole point of
  // letting a plugin name one: `dev_logs` and `read` are both
  // pictures, but only one of them is obviously a picture.
  void registryVersion();
  const declared = toolRenderer(tool)?.icon;
  if (declared) return declared as ToolIconName;
  const kind = toolKind(tool);
  if (kind === "shell") return "terminal";
  if (kind === "read") {
    const path = input ? field(input, ["filePath", "file_path", "path", "file"]) : undefined;
    if (path && /\.(png|jpe?g|gif|webp|avif|bmp|ico|tiff?|heic)$/i.test(path)) return "image";
    return "page";
  }
  if (kind === "edit") return "pencil";
  if (kind === "search") return tool.toLowerCase() === "glob" ? "folder" : "search";
  if (kind === "web") return "globe";
  if (kind === "todo") return "list";
  if (kind === "task") return "fork";
  if (tool.toLowerCase().includes("screenshot")) return "image";
  // A plugin tool with no declared renderer still gets a mark that says
  // "outside the builtin set" rather than pretending to be a file read.
  if (pluginOfTool(tool)) return "fork";
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
  if (
    call.tool.toLowerCase() === "question" ||
    (isInteractiveTool(call.tool) && Array.isArray(input.questions))
  ) {
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

export interface AssistantMetrics {
  ttft_ms?: number;
  output_tps?: number;
}

/** Completion-time metrics derived only from backend clocks and reported output usage. */
export function assistantMetrics(
  message: Pick<Turn["assistant"][number], "content" | "latency_ms" | "partial" | "ts" | "usage">,
): AssistantMetrics {
  const latency = message.latency_ms;
  if (message.partial === true || latency === undefined || !Number.isFinite(latency) || latency < 0 || !message.ts) {
    return {};
  }
  const completed = Date.parse(message.ts);
  if (!Number.isFinite(completed)) return {};
  let firstOutput: number | undefined;
  for (const block of message.content) {
    if (block.type !== "text" && block.type !== "thinking") continue;
    const started = block.started_ms;
    if (block.text.trim() === "" || started === undefined || !Number.isFinite(started) || started < REAL_INSTANT_MS) {
      continue;
    }
    firstOutput = firstOutput === undefined ? started : Math.min(firstOutput, started);
  }
  if (firstOutput === undefined) return {};

  const ttft = firstOutput - (completed - latency);
  const outputWindow = completed - firstOutput;
  const output = message.usage?.output;
  const outputTps = output === undefined ? undefined : (output * 1000) / outputWindow;
  return {
    ...(ttft >= 0 ? { ttft_ms: ttft } : {}),
    ...(output !== undefined && Number.isFinite(output) && output > 0 && outputWindow > 0 && Number.isFinite(outputTps)
      ? { output_tps: outputTps }
      : {}),
  };
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

export type QuestionAnswer = {
  header?: string;
  question: string;
  /** empty = unanswered */
  choices: { label: string; description?: string; custom: boolean }[];
};

const ANSWERED_PREFIX = "User has answered your questions: ";
const ANSWERED_SUFFIX = ". You can now continue with the user's answers in mind.";

export function questionAnswers(call: {
  tool: string;
  input?: Record<string, unknown>;
  output?: string;
}): QuestionAnswer[] | undefined {
  if (!isInteractiveTool(call.tool)) return undefined;
  const output = call.output;
  if (typeof output !== "string") return undefined;
  const raw = call.input?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const questions: { entry: Record<string, unknown>; question: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return undefined;
    const question = (item as Record<string, unknown>).question;
    if (typeof question !== "string") return undefined;
    questions.push({ entry: item as Record<string, unknown>, question });
  }
  const text = output.trimEnd();
  if (!text.startsWith(ANSWERED_PREFIX) || !text.endsWith(ANSWERED_SUFFIX)) return undefined;
  const body = text.slice(ANSWERED_PREFIX.length, text.length - ANSWERED_SUFFIX.length);

  const out: QuestionAnswer[] = [];
  let cursor = 0;
  for (let i = 0; i < questions.length; i++) {
    const { entry, question } = questions[i];
    const marker = `"${question}"="`;
    const expected = i === 0 ? marker : `, ${marker}`;
    if (!body.startsWith(expected, cursor)) return undefined;
    const answerStart = cursor + expected.length;
    let answerEnd: number;
    if (i + 1 < questions.length) {
      const needle = `", "${questions[i + 1].question}"="`;
      const at = body.indexOf(needle, answerStart);
      if (at === -1) return undefined;
      answerEnd = at;
      cursor = at + 1;
    } else {
      if (!body.endsWith('"')) return undefined;
      answerEnd = body.length - 1;
    }
    const answer = body.slice(answerStart, answerEnd);

    const options = Array.isArray(entry.options) ? entry.options : [];
    const labels = new Map<string, string | undefined>();
    for (const option of options) {
      if (!option || typeof option !== "object") continue;
      const label = (option as Record<string, unknown>).label;
      if (typeof label !== "string") continue;
      const description = (option as Record<string, unknown>).description;
      labels.set(label, typeof description === "string" && description !== "" ? description : undefined);
    }
    const choice = (label: string): QuestionAnswer["choices"][number] => {
      const description = labels.get(label);
      return {
        label,
        custom: !labels.has(label),
        ...(description !== undefined ? { description } : {}),
      };
    };
    let choices: QuestionAnswer["choices"];
    if (answer === "Unanswered") {
      choices = [];
    } else {
      const parts = answer.split(", ");
      choices =
        parts.length > 1 && parts.every((part) => labels.has(part))
          ? parts.map(choice)
          : [choice(answer)];
    }

    const header = entry.header;
    out.push({
      ...(typeof header === "string" && header !== "" ? { header } : {}),
      question,
      choices,
    });
  }
  return out;
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
 * The permission decision, assembled from parts rather than concatenated.
 *
 * English says `Denied by you` — verb, space, actor, preposition. Chinese has
 * no slot to fill and says `你已拒绝` — actor first, verb tight against it. One
 * template cannot serve both word orders, so `permission.by` is a two-slot
 * frame that each language fills its own way and the actor and verb are looked
 * up separately before they meet.
 */
export function permissionVerdict(permission: ToolCallView["permission"]): string | undefined {
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
  return actor ? t("permission.by", { verb, actor }) : verb;
}

/**
 * The rule or reason behind a decision, kept apart from the verdict.
 *
 * The backend's `default` means "no rule matched, the policy's default
 * applied"; pasted after a dash it read like a rule called default. The policy
 * editor's own words are used for that one. A named rule is the most precise
 * answer and wins over the prose beside it; anything else is passed through.
 */
export function permissionReason(permission: ToolCallView["permission"]): string | undefined {
  if (!permission || !permission.decision) return undefined;
  if (permission.rule_id) return permission.rule_id;
  if (permission.reason === "default") return t("permission.reason.default");
  return permission.reason;
}

/** The verdict and its reason as one sentence, for a tooltip or a status line. */
export function permissionLabel(permission: ToolCallView["permission"]): string | undefined {
  const verdict = permissionVerdict(permission);
  if (!verdict) return undefined;
  const reason = permissionReason(permission);
  return reason ? t("permission.with_reason", { verb: verdict, reason }) : verdict;
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
