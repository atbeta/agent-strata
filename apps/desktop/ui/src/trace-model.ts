/**
 * The trace's data model: events in, blocks out, no DOM.
 *
 * This module is pure so `bun test` can drive it directly. Text that the
 * interface must translate travels as stand-in markers — `titleKey` names a
 * dictionary key, and the few legacy stand-in words ("输入", "回复", "tool",
 * "message", "reply") are translated at display time by `displayTitle` /
 * `displayPreview` in trace-display.ts. Backend words (tool names, model ids, file
 * paths, the session's own text) pass through verbatim.
 */
import type { MessageKey } from "./locales/zh";
import { mergeUserBar } from "./trace-window";

/** The fields of a stored event the trace reads. Looser than the schema
 *  union: `/events` returns JSON, and every field below is read defensively. */
export interface TraceSourceEvent {
  id: string;
  session_id: string;
  type: string;
  seq: number;
  ts: string;
  data: Record<string, unknown>;
}

/** The event types the trace draws — sent as the page filter so the strip
 *  does not pay to transfer events no lane can show. */
export const TRACE_TYPES = [
  "turn.user",
  "turn.assistant",
  "tool.call",
  "tool.result",
  "file.changed",
  "session.compacted",
  "session.status",
  "session.error",
  "session.goal",
  "plan.updated",
  "permission.requested",
  "permission.resolved",
  "question.asked",
  "question.resolved",
];

export type TraceLane = "user" | "assistant" | "tool" | "event";

export type TraceEventKind =
  | "compacted"
  | "compacting"
  | "retry"
  | "error"
  | "permission"
  | "question"
  | "file"
  | "goal"
  | "plan";

export type TraceStatus = "ok" | "error" | "interrupted" | "pending";

export interface TraceUsage {
  input: number;
  output: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface TraceFile {
  path: string;
  change: string;
  diff?: string;
  whole_file?: boolean;
}

export interface TracePermission {
  request_id: string;
  tool?: string;
  input?: unknown;
  decision?: "allow" | "deny";
  by?: string;
  scope?: string;
  rule_id?: string;
  reason?: string;
}

export interface TraceStep {
  reason: string;
  usage: { input: number; output: number; reasoning?: number };
  cost_usd: number;
}

export interface TraceBlock {
  key: string;
  /** last event seq of the block — the replay position (view?until_seq=) */
  seq: number;
  /** first event seq — where the block sorts in the session */
  firstSeq: number;
  /** raw timestamp of the last event, for the drawer's clock display */
  ts: string;
  /** activity window, ms epoch: tool call → result, assistant start → end */
  startTs: number;
  endTs: number;
  lane: TraceLane;
  /** which marker, when lane === "event" */
  kind?: TraceEventKind;
  /** 1-based position of the block's turn_id in first-appearance order */
  turn?: number;
  /** 1-based position among the turn's non-user blocks, in seq order */
  step?: number;
  /** the assistant block a tool call was declared by (tool.call.msg_id) */
  parentKey?: string;
  status: TraceStatus;
  title: string;
  /** dictionary key for stand-in titles — translated where it is shown */
  titleKey?: MessageKey;
  preview: string;
  /** Raw event payloads, not serialised. The drawer decides how to render them. */
  input?: unknown;
  result?: unknown;
  /** duration the backend reported — also what sizes a duration-mode bar */
  latencyMs?: number;
  usage?: TraceUsage;
  costUsd?: number;
  /** each model call the message ran — which step cost, which step stopped */
  steps?: TraceStep[];
  model?: string;
  agent?: string;
  variant?: string;
  stopReason?: string;
  /** why an assistant message ended in error, when the backend reported one */
  errorText?: string;
  /** full thinking text — the preview only carries its first slice */
  thinking?: string;
  /** summed duration of the thinking blocks that carried a clock */
  thinkingMs?: number;
  /** this message IS the compaction summary, not a reply — label it */
  summary?: boolean;
  childSessionId?: string;
  files?: TraceFile[];
  permission?: TracePermission;
  /** the call was refused — tinted like an error wherever status shows */
  denied?: boolean;
  /** kind-specific marker payload for the drawer */
  event?: unknown;
  /** consecutive retries collapsed into this marker */
  count?: number;
  tone: string;
  /** thinking only, no user-visible text */
  quiet?: boolean;
}

function parts(content: unknown): { type?: string; text?: string; started_ms?: number; ended_ms?: number }[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && typeof b === "object") as {
    type?: string;
    text?: string;
    started_ms?: number;
    ended_ms?: number;
  }[];
}

function textOf(content: unknown, kind: "spoken" | "thinking"): string {
  return parts(content)
    .filter((b) => (kind === "thinking" ? b.type === "thinking" : b.type !== "thinking"))
    .map((b) => b.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** Summed thinking time: only blocks whose backend reported a real clock. */
function thinkingMsOf(content: unknown): number | undefined {
  let sum = 0;
  for (const b of parts(content)) {
    if (
      b.type === "thinking" &&
      typeof b.started_ms === "number" &&
      typeof b.ended_ms === "number"
    ) {
      sum += Math.max(0, b.ended_ms - b.started_ms);
    }
  }
  return sum > 0 ? sum : undefined;
}

function toolTone(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("search") || n.includes("fetch") || n.includes("web")) return "bg-event-tool";
  if (/(^|_)(read|glob|grep|list)($|_)/.test(n) || n === "read") return "bg-event-file";
  if (n.includes("edit") || n.includes("write") || n.includes("patch")) return "bg-event-user";
  if (n === "question" || n.includes("ask")) return "bg-event-permission";
  if (n === "skill") return "bg-status-completed";
  return "bg-primary";
}

function inputPreview(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return pretty(input);
  const o = input as Record<string, unknown>;
  for (const key of ["query", "command", "url", "path", "file_path", "pattern", "name", "prompt"]) {
    if (typeof o[key] === "string" && o[key]) return o[key] as string;
  }
  if (Array.isArray(o.questions) && o.questions[0] && typeof o.questions[0] === "object") {
    const q = (o.questions[0] as { question?: string }).question;
    if (q) return q;
  }
  return pretty(input);
}

function pretty(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** A finite number, or nothing — nulls and strings are dropped, not rendered as NaN. */
function numOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function usageOf(value: unknown): TraceUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const u = value as Record<string, unknown>;
  const input = numOf(u.input);
  const output = numOf(u.output);
  if (input === undefined && output === undefined) return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    reasoning: numOf(u.reasoning),
    cache_read: numOf(u.cache_read),
    cache_write: numOf(u.cache_write),
  };
}

function clockOf(ts: string): number {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : 0;
}

interface MarkerOpts {
  key: string;
  seq: number;
  ts: string;
  turn?: number;
  kind: TraceEventKind;
  titleKey: MessageKey;
  preview?: string;
  status?: TraceStatus;
  event?: unknown;
  tone: string;
  extra?: Partial<TraceBlock>;
}

function marker(o: MarkerOpts): TraceBlock {
  const t = clockOf(o.ts);
  return {
    key: o.key,
    seq: o.seq,
    firstSeq: o.seq,
    ts: o.ts,
    startTs: t,
    endTs: t,
    lane: "event",
    kind: o.kind,
    turn: o.turn,
    status: o.status ?? "ok",
    title: o.kind,
    titleKey: o.titleKey,
    preview: o.preview ?? "",
    event: o.event,
    tone: o.tone,
    ...o.extra,
  };
}

export function traceBlocks(events: TraceSourceEvent[]): TraceBlock[] {
  const blocks: TraceBlock[] = [];
  const tools = new Map<string, TraceBlock>();
  const assistants = new Map<string, TraceBlock>();
  const users = new Map<string, TraceBlock>();
  const turnIndex = new Map<string, number>();
  /** request_id → the block the permission belongs to (tool bar or marker) */
  const permTargets = new Map<string, TraceBlock>();
  const perms = new Map<string, TracePermission>();
  const questions = new Map<string, TraceBlock>();
  /** the retry marker consecutive session.status retries merge into */
  let retryRun: TraceBlock | null = null;

  /** Turn numbers count the turn ids as they first appear — the same order
   *  the conversation was written, not a sort. */
  const turnFor = (turnId: string): number => {
    let n = turnIndex.get(turnId);
    if (n === undefined) {
      n = turnIndex.size + 1;
      turnIndex.set(turnId, n);
    }
    return n;
  };
  /** A marker belongs to the turn in progress when it was written. */
  const markerTurn = () => turnIndex.size || undefined;

  for (const e of events) {
    const d = e.data;
    const t = clockOf(e.ts);
    if (e.type === "turn.user") {
      const turnId = String(d.turn_id ?? e.id);
      const preview = textOf(d.content, "spoken") || "message";
      const prev = users.get(turnId);
      const merged = mergeUserBar(
        prev && { seq: prev.seq, ts: prev.ts, preview: prev.preview },
        { seq: e.seq, ts: e.ts, preview },
      );
      if (prev) {
        prev.seq = merged.seq;
        prev.ts = merged.ts;
        prev.preview = merged.preview;
        if (t > 0) prev.startTs = Math.min(prev.startTs, t);
        prev.endTs = prev.startTs;
      } else {
        const block: TraceBlock = {
          key: `u:${turnId}`,
          seq: merged.seq,
          firstSeq: e.seq,
          ts: merged.ts,
          startTs: t,
          endTs: t,
          lane: "user",
          turn: turnFor(turnId),
          status: "ok",
          title: "输入",
          preview: merged.preview,
          tone: "bg-event-user",
        };
        users.set(turnId, block);
        blocks.push(block);
      }
    } else if (e.type === "turn.assistant") {
      const id = String(d.msg_id ?? e.id);
      const spoken = textOf(d.content, "spoken");
      const thought = textOf(d.content, "thinking");
      const thinkingMs = thinkingMsOf(d.content);
      const model = strOf(d.model);
      const agent = strOf(d.agent);
      const variant = strOf(d.variant);
      const stopReason = strOf(d.stop_reason);
      const latencyMs = numOf(d.latency_ms);
      const usage = usageOf(d.usage);
      const costUsd = numOf(d.cost_usd);
      const steps = Array.isArray(d.steps) ? (d.steps as TraceStep[]) : undefined;
      const errText = strOf(d.error);
      const summary = d.summary === true;
      const prev = assistants.get(id);
      if (prev) {
        prev.seq = e.seq;
        prev.ts = e.ts;
        if (t > 0) {
          prev.endTs = t;
          const lat = latencyMs ?? prev.latencyMs;
          prev.startTs = lat !== undefined ? Math.max(0, t - lat) : t;
        }
        prev.preview = spoken || thought.slice(0, 280) || prev.preview;
        if (thought) prev.thinking = thought;
        if (thinkingMs !== undefined) prev.thinkingMs = thinkingMs;
        prev.quiet = !spoken;
        prev.model = model ?? prev.model;
        prev.agent = agent ?? prev.agent;
        prev.variant = variant ?? prev.variant;
        prev.stopReason = stopReason ?? prev.stopReason;
        prev.steps = steps ?? prev.steps;
        if (latencyMs !== undefined) prev.latencyMs = latencyMs;
        if (usage) prev.usage = usage;
        if (costUsd !== undefined) prev.costUsd = costUsd;
        if (summary) {
          prev.summary = true;
          prev.titleKey = "trace.event.summary";
        }
        if (errText !== undefined) {
          prev.errorText = errText;
          prev.status = "error";
          prev.tone = "bg-status-error";
        } else if (prev.status !== "error") {
          prev.tone = "bg-event-assistant";
        }
        prev.title = model ? model.slice(model.indexOf("/") + 1) : prev.title;
      } else {
        const block: TraceBlock = {
          key: `a:${id}`,
          seq: e.seq,
          firstSeq: e.seq,
          ts: e.ts,
          startTs: latencyMs !== undefined && t > 0 ? Math.max(0, t - latencyMs) : t,
          endTs: t,
          lane: "assistant",
          turn: turnFor(String(d.turn_id ?? id)),
          status: errText !== undefined ? "error" : "ok",
          title: model ? model.slice(model.indexOf("/") + 1) : "回复",
          titleKey: summary ? "trace.event.summary" : undefined,
          preview: spoken || thought.slice(0, 280) || "reply",
          latencyMs,
          usage,
          costUsd,
          steps,
          model,
          agent,
          variant,
          stopReason,
          errorText: errText,
          thinking: thought || undefined,
          thinkingMs,
          summary: summary || undefined,
          tone: errText !== undefined ? "bg-status-error" : "bg-event-assistant",
          quiet: !spoken,
        };
        assistants.set(id, block);
        blocks.push(block);
      }
    } else if (e.type === "tool.call") {
      const callId = String(d.call_id ?? e.id);
      const title = String(d.tool ?? "tool");
      const prev = tools.get(callId);
      if (prev) {
        // A second call for one id carries a child session or a later input.
        // Pushing another block reuses the key: the list draws two rows on
        // top of each other and the call count doubles.
        const child = strOf(d.child_session_id);
        if (child) prev.childSessionId = child;
        if (d.input !== undefined) {
          prev.input = d.input;
          const preview = inputPreview(d.input);
          if (preview) prev.preview = preview;
        }
        if (title !== "tool") prev.title = title;
      } else {
        const block: TraceBlock = {
          key: `t:${callId}`,
          seq: e.seq,
          firstSeq: e.seq,
          ts: e.ts,
          startTs: t,
          endTs: t,
          lane: "tool",
          turn: turnFor(String(d.turn_id ?? callId)),
          parentKey: strOf(d.msg_id) ? `a:${strOf(d.msg_id)}` : undefined,
          status: "pending",
          title,
          preview: inputPreview(d.input) || title,
          input: d.input,
          childSessionId: strOf(d.child_session_id),
          tone: toolTone(title),
        };
        tools.set(callId, block);
        blocks.push(block);
      }
    } else if (e.type === "tool.result") {
      const callId = String(d.call_id ?? "");
      const block = tools.get(callId);
      if (block) {
        block.seq = e.seq;
        block.ts = e.ts;
        block.result = d.output;
        const latencyMs = numOf(d.latency_ms);
        if (latencyMs !== undefined) block.latencyMs = latencyMs;
        block.endTs = t > 0 ? t : block.startTs + (latencyMs ?? 0);
        block.status =
          d.status === "error" ? "error" : d.status === "interrupted" ? "interrupted" : "ok";
        if (d.status === "error") block.tone = "bg-status-error";
        else if (d.status === "interrupted") block.tone = "bg-status-cancelled";
        const child = strOf(d.child_session_id);
        if (child) block.childSessionId = child;
      }
    } else if (e.type === "file.changed") {
      const change: TraceFile = {
        path: String(d.path ?? ""),
        change: String(d.change ?? "modify"),
        diff: strOf(d.diff),
        whole_file: d.whole_file === true || undefined,
      };
      const callId = strOf(d.call_id);
      const tool = callId ? tools.get(callId) : undefined;
      if (tool) {
        (tool.files ??= []).push(change);
        tool.seq = e.seq;
      } else {
        blocks.push(
          marker({
            key: `e:file:${e.id}`,
            seq: e.seq,
            ts: e.ts,
            turn: markerTurn(),
            kind: "file",
            titleKey: "trace.event.file",
            preview: change.path,
            event: change,
            tone: "bg-event-file",
            extra: { files: [change] },
          }),
        );
      }
    } else if (e.type === "session.compacted") {
      blocks.push(
        marker({
          key: `e:comp:${e.id}`,
          seq: e.seq,
          ts: e.ts,
          turn: markerTurn(),
          kind: "compacted",
          titleKey: "trace.event.compacted",
          preview: d.auto === true ? "auto" : d.overflow === true ? "overflow" : "",
          event: {
            auto: d.auto === true,
            overflow: d.overflow === true,
            message_id: strOf(d.message_id),
          },
          tone: "bg-status-completed",
        }),
      );
    } else if (e.type === "session.status") {
      if (d.state === "retry") {
        const info = d.retry && typeof d.retry === "object" ? d.retry : undefined;
        if (retryRun) {
          retryRun.seq = e.seq;
          retryRun.ts = e.ts;
          if (t > 0) retryRun.endTs = t;
          retryRun.count = (retryRun.count ?? 1) + 1;
          retryRun.event = info;
          retryRun.preview = strOf((info as Record<string, unknown> | undefined)?.message) ?? retryRun.preview;
        } else {
          retryRun = marker({
            key: `e:retry:${e.id}`,
            seq: e.seq,
            ts: e.ts,
            turn: markerTurn(),
            kind: "retry",
            titleKey: "trace.event.retry",
            preview: strOf((info as Record<string, unknown> | undefined)?.message) ?? "",
            event: info,
            tone: "bg-status-cancelled",
            extra: { count: 1 },
          });
          blocks.push(retryRun);
        }
      } else {
        retryRun = null;
        if (d.state === "compacting") {
          blocks.push(
            marker({
              key: `e:comping:${e.id}`,
              seq: e.seq,
              ts: e.ts,
              turn: markerTurn(),
              kind: "compacting",
              titleKey: "trace.event.compacting",
              tone: "bg-status-completed",
            }),
          );
        }
        // busy / idle carry no marker
      }
    } else if (e.type === "session.error") {
      // null clears the previous failure — nothing to mark.
      if (d.error && typeof d.error === "object") {
        const diag = d.error as Record<string, unknown>;
        blocks.push(
          marker({
            key: `e:err:${e.id}`,
            seq: e.seq,
            ts: e.ts,
            turn: markerTurn(),
            kind: "error",
            titleKey: "trace.event.error",
            preview: strOf(diag.message) ?? "",
            status: "error",
            event: diag,
            tone: "bg-status-error",
          }),
        );
      }
    } else if (e.type === "permission.requested") {
      const perm: TracePermission = {
        request_id: String(d.request_id),
        tool: strOf(d.tool),
        input: d.input,
      };
      perms.set(perm.request_id, perm);
      const callId = strOf(d.call_id);
      const tool = callId ? tools.get(callId) : undefined;
      if (tool) {
        tool.permission = perm;
        // Replay seeks by seq. Moving the tool to the permission's seq lands
        // the reader on the ask instead of the call.
        permTargets.set(perm.request_id, tool);
      } else {
        const block = marker({
          key: `e:perm:${perm.request_id}`,
          seq: e.seq,
          ts: e.ts,
          turn: markerTurn(),
          kind: "permission",
          titleKey: "trace.event.permission",
          preview: [perm.tool, inputPreview(d.input)].filter(Boolean).join(" "),
          event: perm,
          tone: "bg-event-permission",
          extra: { permission: perm, input: d.input },
        });
        permTargets.set(perm.request_id, block);
        blocks.push(block);
      }
    } else if (e.type === "permission.resolved") {
      const requestId = String(d.request_id);
      const perm = perms.get(requestId) ?? { request_id: requestId };
      perm.decision = d.decision === "deny" ? "deny" : "allow";
      perm.by = strOf(d.by);
      perm.scope = strOf(d.scope);
      perm.rule_id = strOf(d.rule_id);
      perm.reason = strOf(d.reason);
      perms.set(requestId, perm);
      const target = permTargets.get(requestId);
      if (target) {
        if (target.lane !== "tool") target.seq = e.seq;
        target.permission = perm;
        if (perm.decision === "deny") {
          target.denied = true;
          target.tone = "bg-status-error";
          if (target.status === "pending" || target.status === "ok") target.status = "error";
        }
      }
    } else if (e.type === "question.asked") {
      const requestId = String(d.request_id);
      const qs = Array.isArray(d.questions) ? d.questions : [];
      const first = qs[0] as { question?: string } | undefined;
      const block = marker({
        key: `e:q:${requestId}`,
        seq: e.seq,
        ts: e.ts,
        turn: markerTurn(),
        kind: "question",
        titleKey: "trace.event.question",
        preview: strOf(first?.question) ?? "",
        event: { request_id: requestId, questions: qs },
        tone: "bg-event-permission",
      });
      questions.set(requestId, block);
      blocks.push(block);
    } else if (e.type === "question.resolved") {
      const marker = questions.get(String(d.request_id));
      if (marker) {
        marker.seq = e.seq;
        marker.event = {
          ...(marker.event as Record<string, unknown>),
          decision: strOf(d.decision),
          answers: Array.isArray(d.answers) ? d.answers : undefined,
        };
      }
    } else if (e.type === "session.goal") {
      blocks.push(
        marker({
          key: `e:goal:${e.id}`,
          seq: e.seq,
          ts: e.ts,
          turn: markerTurn(),
          kind: "goal",
          titleKey: "trace.event.goal",
          preview: strOf(d.text) ?? "",
          event: { text: strOf(d.text) ?? null, met: d.met === true, paused: d.paused === true },
          tone: "bg-event-assistant",
        }),
      );
    } else if (e.type === "plan.updated") {
      const entries = Array.isArray(d.entries) ? d.entries : [];
      const first = entries[0] as { content?: string } | undefined;
      blocks.push(
        marker({
          key: `e:plan:${e.id}`,
          seq: e.seq,
          ts: e.ts,
          turn: markerTurn(),
          kind: "plan",
          titleKey: "trace.event.plan",
          preview: strOf(first?.content) ?? "",
          event: { entries },
          tone: "bg-muted-foreground",
        }),
      );
    }
  }

  // Steps count the non-user blocks inside each turn, in the order their
  // first event landed — a user prompt is the turn's opener, not a step.
  const ordered = [...blocks].sort((a, b) => a.firstSeq - b.firstSeq || a.seq - b.seq);
  const steps = new Map<number, number>();
  for (const b of ordered) {
    if (b.turn === undefined || b.lane === "user") continue;
    b.step = (steps.get(b.turn) ?? 0) + 1;
    steps.set(b.turn, b.step);
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* filtering                                                           */
/* ------------------------------------------------------------------ */

export interface TraceFilter {
  query: string;
  kind: "all" | "tool" | "error";
}

/** What "error" means for the filter: a failed or interrupted block, a
 *  refused call, or an error marker on the event lane. */
export function isErrorBlock(b: TraceBlock): boolean {
  return (
    b.status === "error" || b.status === "interrupted" || b.denied === true || b.kind === "error"
  );
}

/**
 * `display` maps a block to the words the reader actually sees — stand-in
 * titles are translated at render, so a Chinese query has to match the
 * translated word, not the marker the model stored.
 */
export function filterTrace(
  blocks: TraceBlock[],
  f: TraceFilter,
  display?: { title?(b: TraceBlock): string; preview?(b: TraceBlock): string },
): TraceBlock[] {
  const q = f.query.trim().toLowerCase();
  return blocks.filter((b) => {
    if (f.kind === "tool" && b.lane !== "tool") return false;
    if (f.kind === "error" && !isErrorBlock(b)) return false;
    if (!q) return true;
    const haystacks = [
      b.title,
      b.titleKey ?? "",
      b.preview,
      b.errorText ?? "",
      b.model ?? "",
      b.agent ?? "",
      display?.title?.(b) ?? "",
      display?.preview?.(b) ?? "",
      // a string result is the one place the payload can say "found it" —
      // capped so a 200KB log does not get scanned for every keystroke
      typeof b.result === "string" ? b.result.slice(0, 2_000) : "",
    ];
    return haystacks.some((h) => h.toLowerCase().includes(q));
  });
}

/**
 * The numbers the toolbar reads out: turns, calls, errors, and the *active*
 * time — the span with long silences folded out, the same clock the
 * duration-mode strip draws, not the wall time between the first and the
 * last event.
 */
export function traceSummary(blocks: TraceBlock[]): {
  turns: number;
  calls: number;
  errors: number;
  durationMs: number;
} {
  let calls = 0;
  let errors = 0;
  const userTurns = new Set<number>();
  let maxTurn = 0;
  const chronological = [...blocks].sort((a, b) => a.startTs - b.startTs || a.firstSeq - b.firstSeq);
  let t0 = -1;
  let cursor = 0;
  let collapsed = 0;
  for (const b of chronological) {
    if (isErrorBlock(b)) errors++;
    if (b.turn !== undefined) {
      if (b.turn > maxTurn) maxTurn = b.turn;
      // A tool's turn id is not a conversation round. Counting every id a
      // call minted turned one prompt, its reply, and its call into three.
      if (b.lane === "user") userTurns.add(b.turn);
    }
    if (b.lane === "tool") calls++;
    if (b.startTs <= 0) continue;
    if (t0 < 0) {
      t0 = b.startTs;
      cursor = b.endTs;
      continue;
    }
    if (b.startTs - cursor > GAP_MS) collapsed += b.startTs - cursor;
    if (b.endTs > cursor) cursor = b.endTs;
  }
  const span = t0 < 0 ? 0 : Math.max(0, cursor - t0);
  // User prompts are the rounds. A trace with no prompt (tools only) still
  // reports the turn numbers those calls were given.
  const turns = userTurns.size > 0 ? userTurns.size : maxTurn;
  return { turns, calls, errors, durationMs: Math.max(0, span - collapsed) };
}

/* ------------------------------------------------------------------ */
/* layout                                                              */
/* ------------------------------------------------------------------ */

export type TraceLayoutMode = "duration" | "sequence";

export interface TracePos {
  left: number;
  width: number;
  /** stacked sub-track inside the lane, when bars overlap in time */
  track: number;
}

export interface TraceTurnLabel {
  x: number;
  turn: number;
  /** Dense boundaries keep their line but omit labels that would collide. */
  showLabel: boolean;
}

export interface TraceFold {
  x: number;
  /** Wall-clock silence removed from the duration display. */
  durationMs: number;
}

export interface TraceLayout {
  pos: Map<string, TracePos>;
  width: number;
  /** x of each collapsed-time break (duration mode) */
  breaks: number[];
  folds: TraceFold[];
  /** x of each turn boundary, across all lanes */
  turns: number[];
  turnLabels: TraceTurnLabel[];
  /** ruler ticks: position + elapsed ms at that point (duration mode) */
  ruler: { x: number; ms: number }[];
  /** sub-tracks each lane needs */
  tracks: Partial<Record<TraceLane, number>>;
}

/** Gaps past this are folded into a fixed-width break. */
const GAP_MS = 30_000;
const BREAK_PX = 14;
const MIN_BAR = 6;
const TURN_LABEL_GAP = 56;
/** One displayed minute of activity ≈ 120px. */
const PX_PER_MS = 120 / 60_000;
/** The content cap — past it, bars stop paying for real span. */
const MAX_PX = 64_000;
/** Sequence mode: every block gets the same slot, in first-event order. */
const SLOT_W = 10;
const SLOT_GAP = 3;

/** Ruler ticks land on round numbers, at least ~110px apart. */
const RULER_STEPS = [
  1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
  3_600_000,
];

const bySeq = (a: TraceBlock, b: TraceBlock) => a.firstSeq - b.firstSeq || a.seq - b.seq;

function labelTurns(marks: { x: number; turn: number }[]): TraceTurnLabel[] {
  let lastLabel = -Infinity;
  return marks
    .sort((a, b) => a.x - b.x || a.turn - b.turn)
    .map((mark) => {
      const showLabel = mark.x - lastLabel >= TURN_LABEL_GAP;
      if (showLabel) lastLabel = mark.x;
      return { ...mark, showLabel };
    });
}

export function layoutTrace(blocks: TraceBlock[], mode: TraceLayoutMode): TraceLayout {
  const sorted = [...blocks].sort(bySeq);
  const pos = new Map<string, TracePos>();
  const tracks: Partial<Record<TraceLane, number>> = {};

  if (mode === "sequence") {
    const turnMarks: { x: number; turn: number }[] = [];
    let prevTurn: number | undefined;
    sorted.forEach((b, i) => {
      pos.set(b.key, { left: i * (SLOT_W + SLOT_GAP), width: SLOT_W, track: 0 });
      if (b.turn !== undefined && b.turn !== prevTurn) {
        turnMarks.push({ x: i * (SLOT_W + SLOT_GAP) - SLOT_GAP / 2, turn: b.turn });
      }
      prevTurn = b.turn;
    });
    return {
      pos,
      width: Math.max(0, sorted.length * (SLOT_W + SLOT_GAP) - SLOT_GAP),
      breaks: [],
      folds: [],
      turns: turnMarks.map((mark) => mark.x),
      turnLabels: labelTurns(turnMarks),
      ruler: [],
      tracks,
    };
  }

  const chronological = [...sorted].sort((a, b) => a.startTs - b.startTs || a.firstSeq - b.firstSeq);
  const t0 = chronological.length ? chronological[0]!.startTs : 0;
  // A collapsed gap is measured between consecutive *activity*: nothing runs
  // from the latest end so far to the next start, so overlaps never count.
  const gaps: { start: number; end: number }[] = [];
  let cursor = t0;
  for (const b of chronological) {
    if (b.startTs - cursor > GAP_MS) gaps.push({ start: cursor, end: b.startTs });
    cursor = Math.max(cursor, b.endTs);
  }
  const collapsedMs = gaps.reduce((n, g) => n + (g.end - g.start), 0);
  const shownMs = Math.max(1, cursor - t0 - collapsedMs);
  const scale = shownMs * PX_PER_MS > MAX_PX ? MAX_PX / shownMs : PX_PER_MS;

  // Prefix sums over the folded gaps, so placing a block or a ruler tick is
  // a binary search, not a walk — a store that slept between turns can carry
  // thousands of gaps.
  const gapEnd: number[] = [];
  const cumCut: number[] = [];
  {
    let acc = 0;
    for (const g of gaps) {
      acc += g.end - g.start;
      gapEnd.push(g.end);
      cumCut.push(acc);
    }
  }
  /** index of the first gap ending strictly after `abs` — gaps before it are
   *  fully folded out of the x position */
  const gapsBefore = (abs: number): number => {
    let lo = 0;
    let hi = gapEnd.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (gapEnd[mid]! <= abs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const xOf = (abs: number): number => {
    const i = gapsBefore(abs);
    return (abs - t0 - (i ? cumCut[i - 1]! : 0)) * scale + i * BREAK_PX;
  };

  const turnMin = new Map<number, number>();
  let width = 0;
  for (const b of sorted) {
    const left = xOf(b.startTs);
    const w = Math.max(MIN_BAR, (Math.max(b.endTs, b.startTs) - b.startTs) * scale);
    pos.set(b.key, { left, width: w, track: 0 });
    width = Math.max(width, left + w);
    if (b.turn !== undefined) {
      const m = turnMin.get(b.turn);
      if (m === undefined || left < m) turnMin.set(b.turn, left);
    }
  }

  // Concurrent calls stack rather than overlap: each lane gets up to three
  // sub-tracks, a call taking the first track that has freed up.
  const lanes = new Map<TraceLane, { key: string; s: number; e: number }[]>();
  for (const b of chronological) {
    const arr = lanes.get(b.lane) ?? [];
    arr.push({ key: b.key, s: b.startTs, e: Math.max(b.endTs, b.startTs + MIN_BAR / scale) });
    lanes.set(b.lane, arr);
  }
  for (const [lane, arr] of lanes) {
    const ends: number[] = [];
    for (const item of arr) {
      let track = ends.findIndex((end) => end <= item.s);
      if (track === -1) {
        if (ends.length < 3) {
          ends.push(0);
          track = ends.length - 1;
        } else {
          track = ends.indexOf(Math.min(...ends));
        }
      }
      ends[track] = Math.max(ends[track]!, item.e);
      pos.get(item.key)!.track = track;
    }
    tracks[lane] = ends.length;
  }

  // Ticks land on round elapsed times inside each active segment; the folded
  // gaps are skipped wholesale, so a session spanning days costs its segments,
  // not its span.
  const ruler: { x: number; ms: number }[] = [];
  const step = RULER_STEPS.find((s) => s * scale >= 110) ?? RULER_STEPS[RULER_STEPS.length - 1]!;
  let segStart = t0;
  let cutMs = 0;
  for (const g of [...gaps, { start: cursor, end: cursor }]) {
    const activeStart = segStart - t0 - cutMs;
    const activeEnd = g.start - t0 - cutMs;
    const first = Math.ceil((activeStart + Number.EPSILON) / step) * step;
    for (let ms = Math.max(step, first); ms < activeEnd; ms += step) {
      ruler.push({ x: xOf(t0 + cutMs + ms), ms });
    }
    cutMs += g.end - g.start;
    segStart = g.end;
  }

  const turnMarks = [...turnMin].map(([turn, x]) => ({ turn, x: Math.max(0, x - 2) }));
  return {
    pos,
    width,
    breaks: gaps.map((g) => xOf(g.start)),
    folds: gaps.map((g) => ({ x: xOf(g.start), durationMs: g.end - g.start })),
    turns: turnMarks.map((mark) => mark.x).sort((a, b) => a - b),
    turnLabels: labelTurns(turnMarks),
    ruler,
    tracks,
  };
}
