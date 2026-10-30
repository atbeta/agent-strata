import type { Event, Part } from "@opencode-ai/sdk/v2";
import {
  REBUILDABLE_EVENT_TYPES,
  isStreamingSnapshot,
  makeEvent,
  type AssistantStep,
  type ContentBlock,
  type EventInput,
  type EventType,
  type RetryAction,
  type SessionDiagnostic,
  type SessionRetry,
} from "@agent-strata/schema";
import { createPatch } from "diff";

/**
 * OpenCode's bus frames and its stored transcript, mapped into the same events.
 * The live stream and a full import both go through here.
 */

export const SHELL_PERMS = new Set(["bash", "pwsh", "powershell", "cmd"]);

// OpenCode clocks are unix milliseconds. Fixture and synthetic values below
// this are not real instants, so those events keep the ingest clock.
const REAL_INSTANT_MS = 1_000_000_000_000;

function sourceTime(ms?: number): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms < REAL_INSTANT_MS) return undefined;
  return new Date(ms).toISOString();
}

/** A content part's clock, kept only when the stamps are real instants. */
function contentTimes(time?: { start: number; end?: number }): {
  started_ms?: number;
  ended_ms?: number;
} {
  const started_ms =
    time != null && Number.isFinite(time.start) && time.start >= REAL_INSTANT_MS ? time.start : undefined;
  const ended_ms =
    time?.end != null && Number.isFinite(time.end) && time.end >= REAL_INSTANT_MS ? time.end : undefined;
  return {
    ...(started_ms !== undefined ? { started_ms } : {}),
    ...(ended_ms !== undefined ? { ended_ms } : {}),
  };
}

/** One shape for a path: separators unified, and a Windows drive path compared without case. */
function pathKey(path: string): string {
  const p = path.replace(/\\/g, "/");
  return /^[A-Za-z]:\//.test(p) ? p.toLowerCase() : p;
}

/**
 * The change a finished edit or write made. An edit carries OpenCode's own
 * unified diff in its metadata; a write carries the whole new file.
 */
function fileChangeOf(
  tool: string,
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
): { path: string; change: "add" | "modify"; diff: string; whole_file?: true } | undefined {
  const { filePath, oldString, newString, content } = input ?? {};
  if (typeof filePath !== "string") return undefined;
  if (tool === "edit") {
    const filediff = metadata?.filediff as { patch?: unknown } | undefined;
    const patch = typeof filediff?.patch === "string" ? filediff.patch : metadata?.diff;
    if (typeof patch === "string" && patch) return { path: filePath, change: "modify", diff: patch };
    if (typeof oldString === "string" && typeof newString === "string") {
      return { path: filePath, change: "modify", diff: createPatch(filePath, oldString, newString) };
    }
    return undefined;
  }
  if (tool === "write" && typeof content === "string") {
    return {
      path: filePath,
      change: metadata?.exists === false ? "add" : "modify",
      diff: createPatch(filePath, "", content),
      whole_file: true,
    };
  }
  return undefined;
}

/** The child session a task tool opened. Only that tool's metadata.sessionId names one. */
function taskChild(tool: string, metadata: Record<string, unknown> | undefined): string | undefined {
  if (tool !== "task" || !metadata) return undefined;
  const id = metadata.sessionId;
  if (typeof id !== "string" || !id) return undefined;
  return id.startsWith("opencode:") ? id : `opencode:${id}`;
}

/** The sentence a failed assistant message carries. OpenCode puts it on the message, not in a part. */
function assistantFailure(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = (error as { data?: { message?: unknown } }).data;
  if (data && typeof data.message === "string" && data.message.trim()) return data.message;
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && name ? name : undefined;
}

function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * What a deliberate stop looks like on the wire: OpenCode reports the abort it
 * ran as a session error. It is not a failure — a run that ended on the
 * reader's word must not paint the session as crashed, so the diagnostic is
 * dropped while the session stills the same way a real error would.
 */
const ABORT_ERROR_NAMES = new Set(["MessageAbortedError", "AbortError"]);

function abortedDiagnostic(d: SessionDiagnostic): boolean {
  if (d.name !== undefined) return ABORT_ERROR_NAMES.has(d.name);
  return d.message === "Aborted" || d.message === "The operation was aborted";
}

/** Only diagnostics that are safe to persist and show. Provider payloads and metadata stay behind. */
function sessionDiagnostic(error: unknown): SessionDiagnostic {
  const outer = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const data = outer.data && typeof outer.data === "object" ? (outer.data as Record<string, unknown>) : {};
  const name = textField(outer.name);
  const message = textField(data.message) ?? name ?? "Unknown session error";
  const statusCode = typeof data.statusCode === "number" && Number.isInteger(data.statusCode) ? data.statusCode : undefined;
  const retries = typeof data.retries === "number" && Number.isInteger(data.retries) && data.retries >= 0 ? data.retries : undefined;
  return {
    message,
    ...(name ? { name } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(typeof data.isRetryable === "boolean" ? { isRetryable: data.isRetryable } : {}),
    ...(retries !== undefined ? { retries } : {}),
    ...(textField(data.ref) ? { ref: textField(data.ref) } : {}),
    ...(textField(data.providerID) ? { providerID: textField(data.providerID) } : {}),
  };
}

function recoveryAction(action: unknown): RetryAction | undefined {
  if (!action || typeof action !== "object") return undefined;
  const raw = action as Record<string, unknown>;
  const out: RetryAction = {
    ...(textField(raw.reason) ? { reason: textField(raw.reason) } : {}),
    ...(textField(raw.provider) ? { provider: textField(raw.provider) } : {}),
    ...(textField(raw.title) ? { title: textField(raw.title) } : {}),
    ...(textField(raw.message) ? { message: textField(raw.message) } : {}),
    ...(textField(raw.label) ? { label: textField(raw.label) } : {}),
    ...(textField(raw.link) ? { link: textField(raw.link) } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

// Deltas arrive per token; a reader needs about twenty frames a second.
export const STREAM_SNAPSHOT_MS = 50;

/**
 * How long a finished turn waits before we claim the session is idle.
 *
 * Long enough for the next assistant message of the same turn to arrive — it is
 * created after the previous one completes, so this window is the gap between
 * the halves of one run. Short enough that a dot on a finished conversation
 * stops within the same beat.
 */
export const SETTLE_DELAY_MS = 250;

/**
 * How long a session may sit with an open assistant message and no activity of
 * its own before the settle fallback stops waiting for that message.
 *
 * The fallback waits for every assistant message to report completion, because
 * a mid-turn gap between two messages must not read as idle. But a message can
 * stay open forever without the turn going on: measured on a real one, a turn
 * whose last tool sat awaiting a permission the reader never saw kept that
 * message open for three hours, and the guard turned the fallback off for all
 * of them — a breathing dot on a conversation nobody was in. Past this window
 * an open message with no running tool is a stall, not a pause, and the next
 * real event re-marks busy if it was wrong.
 */
export const SETTLE_QUIET_MS = 30_000;

/**
 * How long a tool still reported as running keeps the correction back.
 *
 * Nothing in the event stream can tell a long tool from a run the backend
 * dropped: both are a session that has stopped talking, and the only evidence
 * either way is how long that lasts. So the tool gets a ceiling instead of a
 * veto. It has to have one: a settle that a running tool can hold off forever
 * is a settle that never speaks in the exact case it was written for — a run
 * that went quiet without ever completing a message and without ever sending
 * `session.idle` — and `busy` then survives for the life of the session, which
 * is the failure this whole mechanism exists to end. Past this the tool is
 * taken to have been dropped; the next real event re-marks the session busy if
 * that was wrong.
 */
export const SETTLE_STALL_MS = 300_000;

/** Bump when the mapping changes; stored sessions mapped by an older version are rebuilt. */
export const OPENCODE_MAPPER_VERSION = "opencode-14";

/** The event types an import reproduces from OpenCode's own record of a session. */
export const OPENCODE_REBUILT_TYPES: EventType[] = [...REBUILDABLE_EVENT_TYPES];

export interface SnapshotMessage {
  info: { id: string; role: string; time?: { created?: number; completed?: number } };
  parts: Part[];
}

/** OpenCode's stored session, replayed as the bus events that would have built it. */
export function snapshotEvents(sessionID: string, info: unknown, messages: SnapshotMessage[]): Event[] {
  const part = (p: Part) =>
    ({
      id: `import:${p.id}`,
      type: "message.part.updated",
      properties: { sessionID, part: p, time: Date.now() },
    }) as unknown as Event;
  const out: Event[] = [
    { id: `import:${sessionID}`, type: "session.created", properties: { sessionID, info } } as unknown as Event,
  ];
  for (const m of messages) {
    const open = m.info.role === "assistant" && m.info.time?.completed === undefined;
    // parts first: a completed assistant message emits turn.assistant on message.updated
    for (const p of m.parts) out.push(part(p));
    out.push({
      id: `import:${m.info.id}`,
      type: "message.updated",
      properties: { sessionID, info: m.info },
    } as unknown as Event);
    // role and parent land on message.updated, so an in-progress assistant
    // only streams once the parts are applied a second time
    if (open) for (const p of m.parts) out.push(part(p));
  }
  return out;
}

/** Every rebuildable event for one session, mapped from scratch. */
export function rebuildEvents(events: Event[], directory?: string): EventInput[] {
  const mapper = new OpencodeMapper({ directory });
  return events
    .flatMap((e) => mapper.handle(e))
    .filter((e) => !isStreamingSnapshot(e) && OPENCODE_REBUILT_TYPES.includes(e.type));
}

type ToolPart = Extract<Part, { type: "tool" }>;

// The desktop renders images only from data: and blob: URLs (img-src CSP),
// so a remote image stays a file reference.
function fileBlock(part: Extract<Part, { type: "file" }>): ContentBlock {
  const inline = part.url.startsWith("data:");
  if (inline && part.mime.startsWith("image/")) {
    const comma = part.url.indexOf(",");
    if (comma > 0 && part.url.slice(0, comma).endsWith(";base64"))
      return { type: "image", mime: part.mime, data: part.url.slice(comma + 1) };
  }
  // A workspace mention keeps only its path. Its extension already says what it
  // is, and a `text/plain` badge on every `@file` would be noise on the most
  // common kind of reference there is.
  if (part.source && "path" in part.source) return { type: "file_ref", path: part.source.path };
  // An attachment has no workspace path, so `mime` is the only thing that says
  // what it was: without it the transcript shows a bare filename, and a dropped
  // PDF reads exactly like a mentioned text file.
  return { type: "file_ref", path: part.filename ?? (inline ? part.mime : part.url), mime: part.mime };
}

/**
 * A completed tool's attachments, as content blocks. Inline `data:` payloads
 * are capped: a screenshot the size of a small repo belongs to the tool's own
 * record, not to a durable event every reader of it pays to load — past the
 * cap the block keeps the file reference instead of the bytes.
 */
const ATTACH_INLINE_MAX = 1_000_000;

function attachmentBlocks(
  attachments: Array<Extract<Part, { type: "file" }>> | undefined,
): { attachments: ContentBlock[] } | {} {
  if (!attachments?.length) return {};
  const blocks = attachments.map((a) => {
    if (a.url.startsWith("data:") && a.url.length > ATTACH_INLINE_MAX) {
      const source = a.source && "path" in a.source ? a.source.path : undefined;
      return { type: "file_ref" as const, path: source ?? a.filename ?? a.mime, mime: a.mime };
    }
    return fileBlock(a);
  });
  return blocks.length ? { attachments: blocks } : {};
}

interface ToolTrack {
  emittedCall: boolean;
  emittedResult: boolean;
  order: number;
  /** latest state of a part seen before its message named the turn */
  deferred?: ToolPart;
  /** the newest state this part was seen in, so a stall check can tell a running tool from a waiting one */
  status?: string;
  /** the child session this call opened, once any update has named one */
  child?: string;
}

interface MsgState {
  role?: string;
  parentID?: string;
  created?: number;
  completed?: number;
  parts: Map<string, ContentBlock>;
  toolParts: Map<string, ToolTrack>;
  emittedAssistant: boolean;
  streamRetired?: boolean;
  /** message.updated declared this a compaction summary while parts still stream */
  summary?: boolean;
  lastStreamAt?: number;
  /** parts a live delta has extended */
  streamed?: Set<string>;
  patchSeen?: Set<string>;
  /** files a successful edit or write in this message already reported, by pathKey */
  editedPaths?: Set<string>;
  /** compaction parts this message already emitted, by part.id */
  compactionSeen?: Set<string>;
  /** one entry per model call this message ran, keyed by the step part's id */
  steps?: Map<string, AssistantStep>;
  /**
   * A close path (idle, settle, error) already wrote this message's durable
   * final with `stop_reason: "interrupted"`. A real completion may still
   * arrive and replace it — unlike an ordinary final, an interrupted one is
   * not the last word.
   */
  interrupted?: boolean;
}

interface SessionState {
  sessionID: string;
  casfId: string;
  started: boolean;
  /**
   * We met this session through one of its messages rather than through a
   * session.created, so the started event went out with no clock to put on it.
   * The next session event carries the real one and re-stamps it.
   */
  startedBlind?: boolean;
  updated?: number;
  messages: Map<string, MsgState>;
  pendingUserMsgs: Set<string>;
  /**
   * User messages whose turn already resolved. A message stays in the ledger
   * after its turn ends and OpenCode keeps touching it — title, tokens,
   * summaries — so "this user id is known" cannot mean "no work is coming";
   * "its turn already finished" can. Updates to a resolved message are
   * bookkeeping, and bookkeeping is not a new run.
   */
  resolvedUsers?: Set<string>;
  /**
   * Whether we have told downstream this session is generating.
   *
   * Only work evidence opens a run: a user message in flight, an assistant
   * message still open, a permission waiting. The backend's `busy` frame is
   * never trusted — the slower bus keeps claiming it for a run that already
   * ended — but its `idle` is the authoritative close for a turn that
   * completed nothing. Either way a missing `idle` must not leave it set
   * forever: a session that reads "running" while nothing is running is worse
   * than one that reads "running" a moment too long — it is a breathing dot on
   * a dead conversation, and it never corrects itself, so nobody can tell it
   * apart from a real run. The settle pass is what notices the disagreement.
   */
  sawBusy?: boolean;
  /** fingerprint and attempt of the retry currently projected, for status/part dedup */
  retryKey?: string;
  retryAttempt?: number;
  retryError?: SessionDiagnostic;
  /** OpenCode's compacting clock while that operation is active */
  compacting?: number;
  /**
   * The compaction assistant message still in flight. Post-rewrite servers
   * never write `time.compacting` — the summary message itself is the live
   * signal they still send.
   */
  summaryMsg?: string;
  /**
   * Assistant messages seen in this session, by id, carrying the turn they
   * belong to. A turn is finished when every assistant message in it has
   * reported completion.
   *
   * Per message rather than a bare counter, because a turn is several assistant
   * messages and they arrive in order: the second is created after the first has
   * already completed. A counter would read zero the moment the first finished
   * and announce idleness mid-turn — the opposite failure from the one this
   * exists to fix, and a worse one, because it stops the projector clearing a
   * run that is genuinely going.
   */
  liveMsgs?: Map<string, string | undefined>;
  /** last title / directory / archive we emitted, so cost-only session.updated stays quiet */
  metaSeen?: boolean;
  title?: string;
  workspace?: string;
  archived?: boolean;
  parent?: string;
  /** last revert message id we emitted; cleared after revert: null */
  revertMessageID?: string;
  /**
   * When this session last produced an event of its own. The settle fallback
   * reads it: an open message inside a session that has gone quiet is a stall
   * rather than a pause, and one still receiving events is a live turn.
   */
  lastTouch?: number;
  /**
   * Whether this mapper generation has announced an idle for the session.
   *
   * The ledger is memory: a restart or a reconnect rebuilds it, and the store's
   * projection keeps whatever `busy` the previous generation wrote. A guard that
   * only trusted its own memory would refuse the very idle that clears it.
   */
  emittedIdle?: boolean;
}

export class OpencodeMapper {
  sessions = new Map<string, SessionState>();
  /** assistant messages with text no snapshot has carried yet, by message id */
  private held = new Map<string, { s: SessionState; m: MsgState }>();
  /** frames already applied, by `type:id` — see the dedup in `handle` */
  private seenIds = new Set<string>();

  constructor(private opts: { directory?: string; now?: () => number } = {}) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** A snapshot of a held message, unless the last one went out inside the window. */
  private streamSnapshot(messageID: string): EventInput | undefined {
    const held = this.held.get(messageID);
    if (!held) return undefined;
    const { s, m } = held;
    if (m.emittedAssistant || !m.parentID) {
      this.held.delete(messageID);
      return undefined;
    }
    const now = this.now();
    if (now - (m.lastStreamAt ?? 0) < STREAM_SNAPSHOT_MS) return undefined;
    this.held.delete(messageID);
    const content = [...m.parts.values()].filter((b) => b.type !== "file_ref");
    if (!content.length) return undefined;
    m.lastStreamAt = now;
    return this.ev(
      s,
      "turn.assistant",
      {
        turn_id: m.parentID,
        msg_id: messageID,
        partial: true,
        content,
        ...(m.summary ? { summary: true } : {}),
        ...(m.steps?.size ? { steps: [...m.steps.values()] } : {}),
      },
      `opencode:${messageID}:assistant.partial:${Bun.hash(JSON.stringify(content)).toString(36)}`,
      // A snapshot has no clock of its own; the ingest clock would make it the
      // newest thing in a replayed session and reorder the session list. It is
      // published rather than stored, so it needs a clock to be a well-formed
      // event either way — and here the moment it was taken is the truth.
      sourceTime(m.created ?? s.updated) ?? new Date(this.now()).toISOString(),
    );
  }

  hasHeldStreams(): boolean {
    return this.held.size > 0;
  }

  /** Frames the window held back, for the ones whose window has passed. */
  flushStreaming(): EventInput[] {
    const out: EventInput[] = [];
    for (const messageID of [...this.held.keys()]) {
      const snap = this.streamSnapshot(messageID);
      if (snap) out.push(snap);
    }
    return out;
  }

  private retireStreaming(s: SessionState): void {
    for (const [msgID, held] of this.held) if (held.s === s) this.held.delete(msgID);
    for (const m of s.messages.values()) if (m.role === "assistant") m.streamRetired = true;
  }

  /**
   * A message still open when the run is declared over was cut off mid-write:
   * it never produced `time.completed`, so no durable final ever carried it,
   * and the streamed partial — which is published, not stored — vanishes on
   * the next fetch. Closing it here keeps the words it managed and marks the
   * cut (`stop_reason: "interrupted"`) instead of letting the turn end on a
   * reply that is not there.
   *
   * The flag stays soft: a completion that arrives anyway still emits its own
   * final, which replaces this one by msg_id.
   */
  private closeOpenMessages(s: SessionState, out: EventInput[], tag: string): void {
    if (!s.liveMsgs?.size) return;
    for (const [msgID, turnID] of s.liveMsgs) {
      const m = s.messages.get(msgID);
      if (!m || m.emittedAssistant || turnID === undefined) continue;
      m.emittedAssistant = true;
      m.interrupted = true;
      (s.resolvedUsers ??= new Set()).add(turnID);
      out.push(
        this.ev(
          s,
          "turn.assistant",
          {
            turn_id: turnID,
            msg_id: msgID,
            content: [...m.parts.values()].filter((b) => b.type !== "file_ref"),
            stop_reason: "interrupted",
            ...(m.summary ? { summary: true } : {}),
            ...(m.steps?.size ? { steps: [...m.steps.values()] } : {}),
          },
          `opencode:${msgID}:turn.assistant:${tag}`,
        ),
      );
    }
  }

  ev(
    s: SessionState,
    kind: EventInput["type"],
    data: unknown,
    id?: string,
    ts?: string,
  ): EventInput {
    const base = makeEvent(
      {
        session_id: s.casfId,
        source: { backend: "opencode", native_id: s.sessionID },
        type: kind,
        data,
        ...(ts ? { ts } : {}),
      } as EventInput,
      // No source clock means the event carries none. `makeEvent` would fill
      // one in, and the store reads a clock on a re-sent event as the
      // source's own: re-indexing a session would then rewrite the timestamp
      // it already holds with the moment of the re-index, and a row whose
      // last event is that one reads as freshly active forever.
      { clock: ts !== undefined },
    );
    if (id) base.id = id;
    return base;
  }

  /**
   * Say the session is idle when the backend has stopped generating but did not
   * say so itself.
   *
   * This exists because `busy` is only ever cleared by an incoming idle, and the
   * backend does not always send one. A session whose turn finished after a
   * permission was granted ends on `permission.replied` and `session.updated`,
   * with no `session.idle` behind them: measured on a real one, the last
   * `session.status` was `busy` and nothing ever followed it. Every list that
   * shows state then shows a breathing dot on a conversation that finished
   * hours ago, and because the projector only ever hears "busy", nothing can
   * tell it apart from a live run — the one state a reader cannot afford to
   * misread.
   *
   * Two things have to be true before speaking, because an idle that arrives
   * early is its own lie:
   *
   *   - the backend said busy at some point, so this is correcting it rather
   *     than announcing idleness for a session that never started;
   *   - every assistant message we have seen has reported completion — or, if
   *     one is stuck open, the session has gone quiet long enough with no
   *     running tool that the message is a stall rather than a pause.
   *
   * The event is keyed per completion rather than per state change, so it is
   * idempotent under replay: a session already known idle emits nothing.
   */
  /**
   * Announce idleness for turns that finished without the backend saying so.
   *
   * It is deliberately not done at the moment the last assistant message
   * completes. A turn is several messages and the next one is created *after*
   * the previous one has completed, so deciding there announces idleness in the
   * gap between two halves of the same run — the projector then clears `busy`
   * while the session is still working, which is worse than leaving it set,
   * because the run goes on with nothing marking it. Waiting one window lets a
   * message that is already on its way arrive first and keep the session live.
   *
   * A turn that really has ended waits one window and nothing more. The cost is
   * a few hundred milliseconds of a dot still breathing on a conversation that
   * just finished; the alternative is a dot that never stops.
   */
  flushSettles(): EventInput[] {
    const out: EventInput[] = [];
    for (const [s, entry] of [...this.pendingSettles]) {
      // The backend said idle itself, or we already announced: drop the queued
      // correction rather than stacking a second idle under a different id.
      if (!s.sawBusy) {
        this.pendingSettles.delete(s);
        continue;
      }
      if (!this.settleReady(s, entry)) continue;
      this.pendingSettles.delete(s);
      s.sawBusy = false;
      s.retryKey = undefined;
      s.retryAttempt = undefined;
      s.retryError = undefined;
      s.compacting = undefined;
      s.summaryMsg = undefined;
      this.closeOpenMessages(s, out, "settle");
      s.liveMsgs?.clear();
      // The same streaming retirement a real idle does; durable finals still land.
      this.retireStreaming(s);
      out.push(
        this.ev(
          s,
          "session.status",
          { state: "idle" },
          `opencode:${s.sessionID}:session.status:idle:${entry.key}`,
        ),
      );
    }
    return out;
  }

  /**
   * Sessions waiting to be declared idle, and why each is waiting.
   *
   * `afterCompletion` means an assistant message reported completion, so the
   * turn may be over and the short beat is enough to find out. `false` means
   * work was seen but nothing has finished yet — the run may only be starting,
   * and it has to be quiet for a whole window before it can be called over.
   *
   * `key` names what queued it, so a session corrected twice under different
   * evidence does not collapse into one event id and replay as already seen.
   */
  private pendingSettles = new Map<SessionState, { key: string; afterCompletion: boolean }>();

  private queueSettle(s: SessionState, key: string, afterCompletion: boolean): void {
    if (!s.sawBusy) return;
    // A completion is the stronger reason to be here; a work sighting queued
    // behind it must not downgrade it into waiting for the whole quiet window.
    if (afterCompletion) this.pendingSettles.set(s, { key, afterCompletion });
    else if (!this.pendingSettles.has(s)) this.pendingSettles.set(s, { key, afterCompletion });
  }

  /** Whether any tool part in the session is still reported as running. */
  private toolRunning(s: SessionState): boolean {
    for (const m of s.messages.values()) {
      for (const t of m.toolParts.values()) if (t.status === "running") return true;
    }
    return false;
  }

  /**
   * Whether a queued settle may speak.
   *
   * Three questions, in the order they can mislead:
   *
   *   - Did anything finish? No, and the session has not gone quiet for the
   *     whole window — then this is a run in progress and announcing idleness
   *     would clear `busy` out from under work that is genuinely going.
   *   - Is a tool still running? While it is, the run is real; it stops being
   *     evidence only once the session has said nothing at all for the stall
   *     ceiling, because a tool that never reports back and a tool that is
   *     still working look identical from here.
   *   - Is a message still open? A pause while the session is producing events
   *     of its own, a stall once it has gone quiet.
   *
   * The order matters: "every message reported completion" used to be the first
   * test and short-circuited before tool parts were ever looked at, so a turn
   * whose last event was an unreported tool was announced idle one beat in.
   */
  private settleReady(s: SessionState, entry: { afterCompletion: boolean }): boolean {
    const quietFor = this.now() - (s.lastTouch ?? 0);
    if (!entry.afterCompletion && quietFor < SETTLE_QUIET_MS) return false;
    if (this.toolRunning(s) && quietFor < SETTLE_STALL_MS) return false;
    if ((s.liveMsgs?.size ?? 0) > 0 && quietFor < SETTLE_QUIET_MS) return false;
    return true;
  }

  /**
   * How long the ingestor should wait before the next settle flush, or
   * undefined when nothing is waiting.
   *
   * Always a number while a settle is pending. Answering undefined meant
   * "nothing can become ready without a new event", which is true of the
   * conditions and irrelevant to the outcome: the runs that stall do it by
   * going silent, and a silent run produces no event to re-arm anything with.
   */
  settleTimerMs(): number | undefined {
    if (this.pendingSettles.size === 0) return undefined;
    const now = this.now();
    let candidate: number | undefined;
    for (const [s, entry] of this.pendingSettles) {
      if (!s.sawBusy) continue;
      if (this.settleReady(s, entry)) return SETTLE_DELAY_MS;
      const until = Math.max(
        // Not ready because nothing finished: the whole quiet window is still
        // owed before work that never produced an ending can be called over.
        entry.afterCompletion ? SETTLE_DELAY_MS : SETTLE_QUIET_MS,
        // Not ready because a tool or an open message is holding it: whichever
        // ceiling is later.
        this.toolRunning(s) ? SETTLE_STALL_MS : SETTLE_QUIET_MS,
      );
      const wait = Math.max(SETTLE_DELAY_MS, until - (now - (s.lastTouch ?? 0)));
      candidate = candidate === undefined ? wait : Math.max(candidate, wait);
    }
    return candidate;
  }

  /**
   * The session, and the `session.started` event that introduces it.
   *
   * `clock` is the session's own last-updated time, when the frame that
   * brought us here carries it. It matters more than it looks: the store
   * takes the newest event clock as the session's last activity, so a
   * `session.started` stamped with the moment we read the session makes the
   * session look like it was just used — and a re-index on every start would
   * keep it looking that way, forever, whatever the session's real history
   * says.
   *
   * So the started event carries the session's clock whenever the frame
   * already knows it. When the frame does not — a session met through one of
   * its messages — the event goes out without a clock and is re-stamped when
   * one arrives.
   */
  /**
   * Reconcile what this generation believes against what the backend says.
   *
   * Everything else here infers `busy` from the event stream, which is right
   * most of the time and has one failure mode: a frame that never arrives
   * leaves the inference wrong forever. The store's projection is durable and
   * this ledger is not, so a restart or a fresh connect can start believing a
   * session is running while the backend finished it long ago — and no future
   * event is guaranteed to mention that session again.
   *
   * Called once when a connection opens. Not polled: the cost is a single
   * request, and a session that drifts while the stream is healthy has an event
   * to say so. This is the correction for the gap between connections, which is
   * exactly where the information was lost.
   *
   * Only `idle` is acted on. A `busy` in this answer is not evidence the run is
   * live — the same rule the stream handler follows — and announcing it would
   * put a running dot on a session whose frames are simply late.
   */
  reconcileIdle(idleSessionIDs: Iterable<string>): EventInput[] {
    const out: EventInput[] = [];
    for (const sessionID of idleSessionIDs) {
      const s = this.sessions.get(sessionID);
      // A session this generation has never heard of has nothing to correct:
      // the store learned about it from an earlier generation, and its own
      // projection is the only record of a run that is already over.
      if (!s || !s.sawBusy) continue;
      s.sawBusy = false;
      s.emittedIdle = true;
      s.retryKey = undefined;
      s.retryAttempt = undefined;
      s.retryError = undefined;
      s.compacting = undefined;
      s.summaryMsg = undefined;
      this.closeOpenMessages(s, out, "reconcile");
      s.liveMsgs?.clear();
      this.retireStreaming(s);
      out.push(
        this.ev(
          s,
          "session.status",
          { state: "idle" },
          `opencode:${sessionID}:reconcile:idle`,
        ),
      );
    }
    return out;
  }

  private ensureSession(sessionID: string, clock?: number): { s: SessionState; out: EventInput[] } {
    const out: EventInput[] = [];
    let s = this.sessions.get(sessionID);
    if (!s) {
      s = {
        sessionID,
        casfId: `opencode:${sessionID}`,
        started: false,
        messages: new Map(),
        pendingUserMsgs: new Set(),
        lastTouch: this.now(),
      };
      this.sessions.set(sessionID, s);
    }
    if (clock != null && s.updated == null) s.updated = clock;
    if (!s.started) {
      s.started = true;
      const at = sourceTime(s.updated);
      if (at) {
        out.push(
          this.ev(
            s,
            "session.started",
            { workspace: this.opts.directory ?? "unknown" },
            `opencode:${sessionID}:session.started`,
            at,
          ),
        );
      } else {
        s.startedBlind = true;
        out.push(
          this.ev(
            s,
            "session.started",
            { workspace: this.opts.directory ?? "unknown" },
            `opencode:${sessionID}:session.started`,
          ),
        );
      }
    } else if (s.startedBlind && s.updated != null) {
      // The store rewrites a stored event's clock when it is handed a source
      // one, so re-sending the same event id with the real time corrects the
      // timestamp connect already wrote, instead of adding a second row. It
      // waits for a real clock rather than taking a second wrong one.
      const at = sourceTime(s.updated);
      if (at) {
        s.startedBlind = false;
        out.push(
          this.ev(
            s,
            "session.started",
            { workspace: this.opts.directory ?? "unknown" },
            `opencode:${sessionID}:session.started`,
            at,
          ),
        );
      }
    }
    return { s, out };
  }

  // session.created records the baseline. It emits when already archived, or
  // when the created payload already carries a revert (import / rebuild).
  // session.updated emits when title, directory, archive, or revert actually changes.
  private syncMeta(
    s: SessionState,
    info: {
      title?: string;
      directory?: string;
      parentID?: string;
      time?: { updated?: number; created?: number; archived?: number };
      revert?: { messageID: string };
    },
    source: "created" | "updated",
  ): EventInput | undefined {
    const title = info.title;
    const workspace = info.directory;
    const archived = (info.time?.archived ?? 0) > 0;
    const parent = info.parentID ? `opencode:${info.parentID}` : s.parent;
    const revertID = info.revert?.messageID || undefined;
    if (info.time?.updated || info.time?.created) {
      s.updated = info.time.updated ?? info.time.created ?? s.updated;
    }
    const changed =
      !s.metaSeen ||
      s.title !== title ||
      s.workspace !== workspace ||
      s.archived !== archived ||
      (info.parentID !== undefined && s.parent !== parent) ||
      revertID !== s.revertMessageID;
    s.metaSeen = true;
    s.title = title;
    s.workspace = workspace;
    s.archived = archived;
    if (info.parentID) s.parent = parent;
    if (!changed) return;
    if (source === "created" && !archived && !revertID) return;
    const stamp = info.time?.updated ?? info.time?.archived ?? 0;
    // { turn_id } while set; null only on the clear; omit if this session never had one.
    let revert: { turn_id: string } | null | undefined;
    if (revertID) {
      revert = { turn_id: revertID };
      s.revertMessageID = revertID;
    } else if (s.revertMessageID !== undefined) {
      revert = null;
      s.revertMessageID = undefined;
    }
    // A clear must not hash like a session that never had a revert: the store
    // keeps the first body for a given id, so a colliding clear would be dropped.
    const hash = Bun.hash(
      `${title ?? ""}\0${workspace ?? ""}\0${archived ? 1 : 0}${info.parentID ? `\0${info.parentID}` : ""}${revertID ? `\0${revertID}` : revert === null ? "\0" : ""}`,
    ).toString(36);
    return this.ev(
      s,
      "session.updated",
      {
        title,
        workspace,
        archived,
        ...(parent ? { parent_session_id: parent } : {}),
        ...(revert !== undefined ? { revert } : {}),
      },
      `opencode:${s.sessionID}:session.updated:${stamp}:${hash}`,
      sourceTime(info.time?.updated ?? info.time?.archived),
    );
  }

  private ensureMsg(s: SessionState, messageID: string): MsgState {
    let m = s.messages.get(messageID);
    if (!m) {
      m = {
        parts: new Map(),
        toolParts: new Map(),
        emittedAssistant: false,
      };
      s.messages.set(messageID, m);
    }
    return m;
  }

  private flushUser(s: SessionState, out: EventInput[], msgID: string) {
    if (!s.pendingUserMsgs.delete(msgID)) return;
    const m = s.messages.get(msgID);
    if (!m) return;
    const content = [...m.parts.values()].filter((b) => b.type !== "thinking");
    if (!content.length) return;
    out.push(
      this.ev(
        s,
        "turn.user",
        { turn_id: msgID, content },
        `opencode:${msgID}:turn.user`,
        sourceTime(m.created ?? s.updated),
      ),
    );
  }

  /**
   * Real work asserts a run more reliably than the backend's status frame
   * does. `session.status` only travels on transitions, so a session the
   * server still counts as busy emits no second frame for its next turn — a
   * queued message produces user/assistant updates and tool parts while no
   * `busy` ever arrives, and a run whose one frame went missing stays
   * invisible forever. A user message in flight or an assistant message still
   * open is work evidence enough to say the session is running.
   */
  private noteWork(s: SessionState, out: EventInput[], key: string): void {
    // Real output after a retry is recovery evidence. A bare busy frame still
    // gets no such authority, but this work must retire the retry even when the
    // session was already busy.
    if (s.sawBusy && s.retryKey === undefined) return;
    s.retryKey = undefined;
    s.retryAttempt = undefined;
    s.retryError = undefined;
    this.markWork(s, key);
    out.push(
      this.ev(
        s,
        "session.status",
        { state: "busy" },
        `opencode:${s.sessionID}:status:work:${key}`,
      ),
    );
  }

  private markWork(s: SessionState, key: string): void {
    s.sawBusy = true;
    // A new run gets to announce its own ending: the correction above is one
    // per generation, and reusing it here would silence the idle that follows.
    s.emittedIdle = false;
    this.queueSettle(s, `work:${key}`, false);
  }

  private noteRetry(
    s: SessionState,
    out: EventInput[],
    retry: SessionRetry,
    id: string,
    ts?: string,
  ): void {
    const current = {
      ...retry,
      ...(retry.error === undefined && s.retryAttempt === retry.attempt && s.retryError
        ? { error: s.retryError }
        : {}),
    };
    const key = Bun.hash(JSON.stringify(current)).toString(36);
    if (s.retryKey === key) return;
    this.markWork(s, `retry:${current.attempt}`);
    s.retryKey = key;
    s.retryAttempt = current.attempt;
    s.retryError = current.error;
    s.compacting = undefined;
    s.summaryMsg = undefined;
    out.push(this.ev(s, "session.status", { state: "retry", retry: current }, id, ts));
  }

  private syncCompacting(
    s: SessionState,
    out: EventInput[],
    info: { time?: { compacting?: number; updated?: number } },
  ): void {
    const active = info.time?.compacting;
    if (active !== undefined && Number.isFinite(active) && active > 0) {
      if (s.compacting === active) return;
      this.markWork(s, `compacting:${active}`);
      s.compacting = active;
      s.retryKey = undefined;
      s.retryAttempt = undefined;
      s.retryError = undefined;
      out.push(
        this.ev(
          s,
          "session.status",
          { state: "compacting" },
          `opencode:${s.sessionID}:compacting:${active}`,
          sourceTime(active),
        ),
      );
      return;
    }
    if (s.compacting === undefined) return;
    const finished = s.compacting;
    s.compacting = undefined;
    // A compaction message still open means the operation goes on: the session
    // clock ended but its assistant has not finished writing the summary yet.
    if (s.summaryMsg !== undefined) return;
    // Compaction finishing is not the session going idle: its assistant turn
    // may resume immediately, and the usual idle/settle path owns that close.
    out.push(
      this.ev(
        s,
        "session.status",
        { state: "busy" },
        `opencode:${s.sessionID}:compacting:${finished}:done`,
        sourceTime(info.time?.updated),
      ),
    );
  }

  private noteSessionError(s: SessionState, out: EventInput[], error: unknown, id: string): void {
    s.sawBusy = false;
    s.retryKey = undefined;
    s.retryAttempt = undefined;
    s.retryError = undefined;
    s.compacting = undefined;
    s.summaryMsg = undefined;
    this.pendingSettles.delete(s);
    for (const [msgID, held] of this.held) if (held.s === s) this.held.delete(msgID);
    this.closeOpenMessages(s, out, "error");
    s.liveMsgs?.clear();
    // A stop the reader asked for arrives as MessageAbortedError; it closes
    // the session without naming it a failure.
    const diagnostic = sessionDiagnostic(error);
    out.push(
      this.ev(s, "session.error", { error: abortedDiagnostic(diagnostic) ? null : diagnostic }, id),
    );
  }

  private toolEvents(s: SessionState, m: MsgState, part: ToolPart, t: ToolTrack): EventInput[] {
    const out: EventInput[] = [];
    const st = part.state;
    t.status = st.status;
    const child = taskChild(part.tool, st.status === "pending" ? undefined : st.metadata);
    const callData = (childId?: string) => ({
      turn_id: m.parentID ?? part.messageID,
      call_id: part.callID,
      tool: part.tool,
      input: st.input,
      order: t.order,
      // `order` counts only within this message. Naming the message
      // too is what lets a reader see a call beside the words that
      // asked for it instead of in a pile at the end of the turn.
      msg_id: part.messageID,
      ...(childId ? { child_session_id: childId } : {}),
    });
    /**
     * A task part is running before the session it opens exists, so its id
     * arrives in a later update than the call itself. Reading it only at the
     * first non-pending sighting dropped it: the card named no child for as
     * long as the child was working, and the id came back with the result
     * instead — the one moment there is nothing left to go and watch.
     *
     * The call is restated to carry it. A second `tool.call` for one call_id
     * is an update rather than a second card: whichever event the projector
     * meets first writes the call, and the other fills in the child.
     */
    if (st.status !== "pending" && child && child !== t.child) {
      t.child = child;
      if (t.emittedCall) {
        out.push(
          this.ev(
            s,
            "tool.call",
            callData(child),
            `opencode:${part.id}:tool.child`,
            sourceTime(st.time.start || s.updated),
          ),
        );
      }
    }
    if (!t.emittedCall && st.status !== "pending") {
      t.emittedCall = true;
      out.push(
        this.ev(
          s,
          "tool.call",
          callData(child),
          `opencode:${part.id}:tool.call`,
          sourceTime(st.time.start || s.updated),
        ),
      );
    }
    if (!t.emittedResult && (st.status === "completed" || st.status === "error")) {
      t.emittedResult = true;
      out.push(
        this.ev(
          s,
          "tool.result",
          {
            call_id: part.callID,
            status: st.status === "completed" ? "ok" : "error",
            output: st.status === "completed" ? st.output : st.error,
            ...(st.status === "completed" ? attachmentBlocks(st.attachments) : {}),
            latency_ms: Math.max(0, Math.round(st.time.end - st.time.start)),
            ...(child ? { child_session_id: child } : {}),
          },
          `opencode:${part.id}:tool.result`,
          sourceTime(st.time.end || s.updated),
        ),
      );
      if (st.status === "completed") {
        const change = fileChangeOf(part.tool, st.input, st.metadata);
        if (change) {
          out.push(
            this.ev(
              s,
              "file.changed",
              { ...change, call_id: part.callID },
              `opencode:${part.id}:file`,
              sourceTime(st.time.end || s.updated),
            ),
          );
        }
      }
    }
    return out;
  }

  /**
   * Current OpenCode stages a revert on its own event, not on `session.updated`.
   * The boundary is the same fact either way: this message and everything after
   * it is withdrawn until the reader restores it.
   */
  private revertBoundary(evt: Event): EventInput[] | undefined {
    const type = evt.type as string;
    const staged = type === "session.next.revert.staged" || type === "session.revert.staged";
    const cleared = type === "session.next.revert.cleared" || type === "session.revert.cleared";
    if (!staged && !cleared) return undefined;
    const props =
      "properties" in evt && evt.properties && typeof evt.properties === "object"
        ? (evt.properties as { sessionID?: unknown; revert?: { messageID?: unknown } })
        : undefined;
    const sessionID = typeof props?.sessionID === "string" ? props.sessionID : undefined;
    if (!sessionID) return [];
    const messageID = typeof props?.revert?.messageID === "string" ? props.revert.messageID : undefined;
    if (staged && !messageID) return [];
    const { s, out } = this.ensureSession(sessionID);
    const meta = this.syncMeta(
      s,
      {
        title: s.title,
        directory: s.workspace,
        time: s.archived ? { archived: s.updated ?? Date.now() } : undefined,
        ...(messageID ? { revert: { messageID } } : {}),
      },
      "updated",
    );
    if (meta) out.push(meta);
    return out;
  }

  handle(evt: Event): EventInput[] {
    const out: EventInput[] = [];
    /**
     * One frame, once. The same event travels on the global bus and the
     * project bus and they do not keep step: a re-delivered user
     * `message.updated` landing after the turn's idle re-asserts busy and a
     * finished session reads running forever — exactly what a re-delivered
     * idle did to the session's latch before, and what reconnect replay via
     * Last-Event-ID would do to both. `type:` is in the key because OpenCode
     * reuses an envelope id for its `sync` marker; `import:` frames are
     * exempt because a re-import means the data changed.
     */
    if (evt.id && !evt.id.startsWith("import:")) {
      const key = `${evt.type}:${evt.id}`;
      if (this.seenIds.has(key)) return out;
      this.seenIds.add(key);
      if (this.seenIds.size > 8192) {
        this.seenIds.delete(this.seenIds.keys().next().value!);
      }
    }
    const props = "properties" in evt ? evt.properties : undefined;
    const sessionID =
      props && "sessionID" in props ? (props.sessionID as string) : undefined;
    if (sessionID) {
      const known = this.sessions.get(sessionID);
      // Every frame the backend emits for this session is activity, including
      // a `retry`: a run that is being retried has not ended, and the settle
      // fallback must not call it over while it is still moving.
      if (known) known.lastTouch = this.now();
    }

    const boundary = this.revertBoundary(evt);
    if (boundary) return boundary;

    switch (evt.type) {
      case "session.created": {
        const p = evt.properties;
        // A message can arrive before session.created. That first event already
        // stored session.started under a stable id, so a second started event
        // cannot replace its workspace. Publish the real directory as an update.
        const already = this.sessions.get(p.sessionID)?.started === true;
        // Seeded before ensureSession so that a session we only knew through a
        // message can already be re-stamped by it; after, the clock this event
        // carries would arrive too late for the check that wants it.
        const known = this.sessions.get(p.sessionID);
        if (known) known.updated = p.info.time?.updated ?? p.info.time?.created ?? known.updated;
        const { s, out: pre } = this.ensureSession(
          p.sessionID,
          p.info.time?.updated ?? p.info.time?.created,
        );
        out.push(...pre);
        s.updated = p.info.time?.updated ?? p.info.time?.created ?? s.updated;
        if (!already) {
          const i = out.findIndex((e) => e.type === "session.started");
          const started = this.ev(
            s,
            "session.started",
            {
              workspace: p.info.directory,
              title: p.info.title,
              parent_session_id: p.info.parentID ? `opencode:${p.info.parentID}` : undefined,
            },
            `opencode:${p.sessionID}:session.started`,
            sourceTime(s.updated),
          );
          if (i >= 0) out[i] = started;
          else out.push(started);
        }
        this.syncCompacting(s, out, p.info);
        const meta = this.syncMeta(s, p.info, already ? "updated" : "created");
        if (meta) out.push(meta);
        return out;
      }
      case "session.updated": {
        const p = evt.properties;
        // The metadata crawl that indexes a session carries its clock, so the
        // started event is written with the session's own time the first time
        // we see it. Without that, the row's newest event would be the
        // moment we read the session, and the session would read as freshly
        // active on every start.
        const { s, out: pre } = this.ensureSession(
          p.sessionID,
          p.info.time?.updated ?? p.info.time?.created,
        );
        out.push(...pre);
        this.syncCompacting(s, out, p.info);
        const meta = this.syncMeta(s, p.info, "updated");
        if (meta) out.push(meta);
        return out;
      }
      case "session.error": {
        if (!sessionID) {
          // Skill and plugin failures carry no session — nothing to hang the
          // diagnostic on. Dropping it silently made a broken skill invisible;
          // the log is where a session-less fault can still be found.
          console.error("opencode session error:", sessionDiagnostic(evt.properties.error));
          return out;
        }
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        this.noteSessionError(s, out, evt.properties.error, `opencode:${sessionID}:error:${evt.id}`);
        return out;
      }
      case "session.deleted": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        for (const [msgID, held] of this.held) if (held.s === s) this.held.delete(msgID);
        out.push(
          this.ev(
            s,
            "session.deleted",
            {},
            `opencode:${p.sessionID}:session.deleted`,
            sourceTime(p.info?.time?.updated),
          ),
        );
        return out;
      }
      case "message.updated": {
        if (!sessionID) return out;
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        const info = evt.properties.info;
        const m = this.ensureMsg(s, info.id);
        m.role = info.role;
        if (info.time?.created) m.created = info.time.created;
        // The SDK types a message's clock as a union — only an assistant
        // message carries `completed` — so this reads it off one shape.
        const clock = info.time as { completed?: number } | undefined;
        if (clock?.completed !== undefined) m.completed = clock.completed;
        // A message whose turn already resolved is bookkeeping, not work —
        // OpenCode keeps touching it after the run ends (title, tokens,
        // summaries) and each such frame, carried on the slower bus past the
        // turn's idle, would put a finished session back to running.
        const resolved =
          info.role === "user" ? (s.resolvedUsers?.has(info.id) ?? false) : m.emittedAssistant;
        if (info.role === "user") {
          if (!resolved) s.pendingUserMsgs.add(info.id);
          // Queued or running, this message is a turn in flight — and the
          // status frame that would say so may never come, so say it here.
          if (!resolved && !evt.id.startsWith("import:")) this.noteWork(s, out, `msg:${info.id}`);
          return out;
        }
        if (info.role === "assistant") {
          // A summary:true assistant message IS the compaction running — the
          // one live signal post-rewrite servers still send, since nothing
          // writes session.time.compacting anymore.
          if (info.summary === true && !evt.id.startsWith("import:")) {
            if (info.time.completed === undefined && !info.error) {
              if (s.summaryMsg !== info.id) {
                s.summaryMsg = info.id;
                this.markWork(s, `compaction:${info.id}`);
                if (s.compacting === undefined) {
                  out.push(
                    this.ev(
                      s,
                      "session.status",
                      { state: "compacting" },
                      `opencode:${info.id}:compacting`,
                      sourceTime(info.time.created ?? s.updated),
                    ),
                  );
                }
              }
            } else if (s.summaryMsg === info.id) {
              s.summaryMsg = undefined;
              // Finished, not failed: the turn resumes, so the state falls back
              // to busy — idle belongs to the usual idle/settle path.
              if (info.time.completed !== undefined && !info.error && s.compacting === undefined) {
                out.push(
                  this.ev(
                    s,
                    "session.status",
                    { state: "busy" },
                    `opencode:${info.id}:compacted`,
                    sourceTime(info.time.completed),
                  ),
                );
              }
            }
          }
          if (info.summary === true) m.summary = true;
          if (!resolved && info.time.completed === undefined && !evt.id.startsWith("import:")) {
            this.noteWork(s, out, `msg:${info.id}`);
          }
          m.parentID = info.parentID;
          (s.liveMsgs ??= new Map()).set(info.id, info.parentID);
          this.flushUser(s, out, info.parentID);
          for (const t of m.toolParts.values()) {
            const part = t.deferred;
            if (!part) continue;
            t.deferred = undefined;
            out.push(...this.toolEvents(s, m, part, t));
          }
          if (info.time.completed !== undefined) m.streamRetired = true;
          if (info.time.completed !== undefined && (!m.emittedAssistant || m.interrupted)) {
            m.emittedAssistant = true;
            m.interrupted = undefined;
            if (info.parentID) (s.resolvedUsers ??= new Set()).add(info.parentID);
            this.held.delete(info.id);
            const content = [...m.parts.values()].filter((b) => b.type !== "file_ref");
            const failure = assistantFailure(info.error);
            const u = info.tokens;
            // Providers occasionally report a negative count (usually output);
            // CASF keeps usage non-negative, and clamping here beats dropping
            // the whole turn on a schema rejection.
            const count = (n: number | undefined) =>
              n === undefined ? undefined : Math.max(0, Math.round(n));
            out.push(
              this.ev(
                s,
                "turn.assistant",
                {
                  turn_id: info.parentID,
                  msg_id: info.id,
                  content,
                  model: `${info.providerID}/${info.modelID}`,
                  agent: info.agent,
                  variant: info.variant,
                  usage: {
                    input: count(u.input) ?? 0,
                    output: count(u.output) ?? 0,
                    reasoning: count(u.reasoning),
                    cache_read: count(u.cache.read),
                    cache_write: count(u.cache.write),
                  },
                  cost_usd: info.cost,
                  latency_ms: Math.max(0, Math.round(info.time.completed - info.time.created)),
                  stop_reason: info.finish ?? (failure ? "error" : undefined),
                  ...(failure ? { error: failure } : {}),
                  ...(info.summary === true ? { summary: true } : {}),
                  ...(m.steps?.size ? { steps: [...m.steps.values()] } : {}),
                  // The answer in the caller's schema, when the format asked
                  // for a json_schema reply. `null` is a valid answer too.
                  ...(info.structured !== undefined ? { structured: info.structured } : {}),
                },
                `opencode:${info.id}:turn.assistant`,
                sourceTime(info.time.completed ?? info.time.created ?? s.updated),
              ),
            );
          }
          if (info.time.completed !== undefined) {
            s.liveMsgs?.delete(info.id);
            this.queueSettle(s, info.id, true);
          }
        }
        return out;
      }
      case "message.part.updated": {
        if (!sessionID) return out;
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        const part: Part = evt.properties.part;
        const m = this.ensureMsg(s, part.messageID);
        const streamContent = part.type === "text" || part.type === "reasoning" || part.type === "file" || part.type === "subtask";
        if (m.role === "assistant" && m.streamRetired && streamContent) return out;
        // An import read mid-reply carries an open part as OpenCode last stored
        // it, which can be older than the deltas already applied; and deltas
        // still in flight would land on top of anything newer. A closed part
        // carries its final text.
        const stale =
          evt.id.startsWith("import:") &&
          !m.emittedAssistant &&
          !!m.streamed?.has(part.id) &&
          (part.type === "text" || part.type === "reasoning") &&
          part.time?.end === undefined;
        if (stale) {
          // keep the delta-built text
        } else if (part.type === "text") {
          // Text OpenCode writes itself (a read file's contents, "continue"
          // nudges). An import replays parts before their message, so the role
          // is unknown here and the rule applies to every message.
          if (part.synthetic || part.ignored) m.parts.delete(part.id);
          else m.parts.set(part.id, { type: "text", text: part.text, ...contentTimes(part.time) });
        } else if (part.type === "reasoning") {
          m.parts.set(part.id, { type: "thinking", text: part.text, ...contentTimes(part.time) });
        } else if (part.type === "file") {
          m.parts.set(part.id, fileBlock(part));
        } else if (part.type === "subtask") {
          // A subagent session's opening message is nothing else: the prompt
          // the task was given. Without the block the turn echoes empty.
          m.parts.set(part.id, {
            type: "subtask",
            prompt: part.prompt,
            description: part.description,
            agent: part.agent,
          });
        } else if (part.type === "step-finish") {
          // Detail for the trace, not content — the message's own usage and
          // cost already carry the sum.
          const t = part.tokens;
          const clamp = (n: number | undefined) =>
            n === undefined ? undefined : Math.max(0, Math.round(n));
          (m.steps ??= new Map()).set(part.id, {
            reason: part.reason,
            usage: {
              input: clamp(t.input) ?? 0,
              output: clamp(t.output) ?? 0,
              reasoning: clamp(t.reasoning),
              cache_read: clamp(t.cache.read),
              cache_write: clamp(t.cache.write),
            },
            cost_usd: Math.max(0, part.cost),
          });
          return out;
        } else if (part.type === "step-start" || part.type === "snapshot" || part.type === "agent") {
          // step-start and snapshot mark bookkeeping the transcript never
          // shows; an agent part restates the "@name" the message's text
          // already carries.
          return out;
        } else if (part.type === "tool") {
          // Parts are created in the order the model declared them, so first
          // sight is the declaration order. tool.call is not emitted until the
          // part leaves `pending`, which for parallel calls is the order they
          // actually started — record the ordinal so readers can restore the
          // order the model wrote.
          let t = m.toolParts.get(part.id);
          if (!t) {
            t = { emittedCall: false, emittedResult: false, order: m.toolParts.size };
            m.toolParts.set(part.id, t);
          }
          if (part.state.status === "completed") {
            const change = fileChangeOf(part.tool, part.state.input, part.state.metadata);
            if (change) (m.editedPaths ??= new Set()).add(pathKey(change.path));
          }
          // A call belongs to the user turn its message answers, and only
          // message.updated names that turn. A stored session replays parts
          // before their message, so the call waits for it.
          if (m.parentID === undefined) {
            t.deferred = part;
            return out;
          }
          out.push(...this.toolEvents(s, m, part, t));
          return out;
        }
        if (part.type === "retry") {
          // A stored retry is history, not proof the session is still waiting.
          if (evt.id.startsWith("import:") || s.retryAttempt === part.attempt) return out;
          const error = sessionDiagnostic(part.error);
          this.noteRetry(
            s,
            out,
            { attempt: part.attempt, message: error.message, error },
            `opencode:${part.id}:retry`,
            sourceTime(part.time.created),
          );
          return out;
        }
        if (part.type === "compaction") {
          const seen = (m.compactionSeen ??= new Set());
          if (seen.has(part.id)) return out;
          seen.add(part.id);
          // Same hole as the patch part below: a compaction carries no clock,
          // so emitting without one stamped it with ingest time — sessions that
          // only re-connected looked freshly active in the list.
          out.push(
            this.ev(
              s,
              "session.compacted",
              {
                message_id: part.messageID,
                auto: part.auto,
                // `overflow` says the trigger was a context-overflow error
                // rather than the size threshold.
                ...(part.overflow === true ? { overflow: true } : {}),
              },
              `opencode:${part.id}:compaction`,
              sourceTime(m.created ?? m.completed ?? s.updated),
            ),
          );
          return out;
        }
        if (part.type === "patch") {
          const seen = (m.patchSeen ??= new Set());
          // A patch part carries no clock of its own, and emitting without one
          // hands the store the ingest clock — so replaying a session on every
          // connect stamped all of its history with the moment we connected,
          // and the session list sorted by that instead of by when the agent
          // last worked. The message this part belongs to does carry one, and
          // the edits land as it finishes.
          const at = sourceTime(m.completed ?? m.created ?? s.updated);
          for (const f of part.files) {
            const key = `${part.id}:${f}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (m.editedPaths?.has(pathKey(f))) continue;
            out.push(
              this.ev(
                s,
                "file.changed",
                { path: f, change: "modify" },
                `opencode:${part.id}:file:${f}`,
                at,
              ),
            );
          }
          return out;
        }
        // shared tail for content parts (text/reasoning/file):
        // — user messages emit turn.user as soon as text lands so the prompt
        //   echoes instantly (id is a content hash: a later, fuller part
        //   snapshot re-emits and the projector overwrites it). The store
        //   keeps every version, so content with images waits for flushUser
        //   and goes out once, whole, under the message's stable id.
        // — assistant messages emit throttled partial turn.assistant
        //   snapshots so the UI streams during generation
        if (m.role === "user") {
          const content = [...m.parts.values()].filter((b) => b.type !== "thinking");
          if (content.some((b) => b.type === "image")) {
            s.pendingUserMsgs.add(part.messageID);
          } else if (content.length) {
            s.pendingUserMsgs.delete(part.messageID);
            out.push(
              this.ev(
                s,
                "turn.user",
                { turn_id: part.messageID, content },
                `opencode:${part.messageID}:turn.user:${Bun.hash(JSON.stringify(content)).toString(36)}`,
                sourceTime(m.created ?? s.updated),
              ),
            );
          }
        } else if (m.role === "assistant" && m.parentID && !m.emittedAssistant) {
          this.held.set(part.messageID, { s, m });
          const snap = this.streamSnapshot(part.messageID);
          if (snap) out.push(snap);
        }
        return out;
      }
      case "message.part.delta": {
        const p = evt.properties;
        if (p.field !== "text") return out;
        const s = this.sessions.get(p.sessionID);
        const m = s?.messages.get(p.messageID);
        const block = m?.parts.get(p.partID);
        // A delta extends a part already held. One for a part never seen (the
        // stream joined mid-message) waits for that part's next full update.
        if (!s || !m || m.streamRetired || !block || (block.type !== "text" && block.type !== "thinking")) return out;
        m.parts.set(p.partID, { ...block, text: block.text + p.delta });
        (m.streamed ??= new Set()).add(p.partID);
        if (m.role === "assistant" && m.parentID && !m.emittedAssistant) {
          this.held.set(p.messageID, { s, m });
          const snap = this.streamSnapshot(p.messageID);
          if (snap) out.push(snap);
        }
        return out;
      }
      case "session.idle":
      case "session.status": {
        if (!sessionID) return out;
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        const status = evt.type === "session.status" ? evt.properties.status : undefined;
        if (status?.type === "retry") {
          if (!Number.isInteger(status.attempt) || status.attempt < 0) return out;
          const action = recoveryAction(status.action);
          this.noteRetry(
            s,
            out,
            {
              attempt: status.attempt,
              message: status.message,
              ...(Number.isFinite(status.next) ? { next: status.next } : {}),
              ...(action ? { action } : {}),
            },
            `opencode:${sessionID}:status:${evt.id}`,
          );
          return out;
        }
        // A busy frame retires a pending retry — work resumed. It says nothing
        // about compaction, though: the summarising call runs inside the same
        // busy span, so mid-compaction busy frames are noise, not an end.
        if (status?.type === "busy" && s.retryKey !== undefined) {
          s.retryKey = undefined;
          s.retryAttempt = undefined;
          s.retryError = undefined;
          out.push(
            this.ev(s, "session.status", { state: "busy" }, `opencode:${sessionID}:status:${evt.id}`),
          );
          return out;
        }
        const idle = evt.type === "session.idle" || status?.type === "idle";
        /**
         * The two directions of a status frame are not worth the same. A busy
         * claim is never evidence: measured on a live server, the slower bus
         * keeps carrying `busy` about a run that already ended, and a queued
         * turn announces itself soon enough through its own messages. The
         * ledger — a user message in flight, an assistant message still open,
         * a tool still running — is what says a session is working.
         *
         * Idle is different: a run the backend says is over is over, even
         * while the ledger still holds a message it never finished. It is the
         * authoritative close for the abort and error paths that complete
         * nothing.
         */
        if (!idle) return out;
        const sawBusyHere = s.sawBusy;
        // Idle closes every open turn. A user message whose turn resolved —
        // or never produced one — keeps getting bookkeeping frames after
        // (title, tokens, summaries), and each would read as a new run.
        // Text parts take a message off pending the moment they land, so
        // resolved has to come from the message ledger, not the queue.
        for (const [msgID, m2] of s.messages) {
          if (m2.role === "user") (s.resolvedUsers ??= new Set()).add(msgID);
        }
        for (const msgID of [...s.pendingUserMsgs]) this.flushUser(s, out, msgID);
        // Late parts cannot revive a partial; a completed update still emits its durable final.
        this.retireStreaming(s);
        s.sawBusy = false;
        s.retryKey = undefined;
        s.retryAttempt = undefined;
        s.retryError = undefined;
        s.compacting = undefined;
        s.summaryMsg = undefined;
        this.closeOpenMessages(s, out, "idle");
        s.liveMsgs?.clear();
        // The backend re-issues idle under fresh ids — a status-idle and a
        // session.idle for one transition, again on reconnect. Only the
        // busy→idle edge is a state worth announcing.
        //
        // Except once per generation. `sawBusy` is memory, and the store's
        // `busy` is not: a restart or a fresh connect starts with an empty
        // ledger while the projection still says running from a generation
        // that is gone. Refusing the backend's idle because *this* generation
        // never saw the busy left that stale flag with nothing able to clear
        // it — the session read as running forever, and a stop went through
        // the same guard and changed nothing.
        //
        // So the first idle a generation hears is always announced; after
        // that the busy→idle edge alone decides, and the duplicate frames a
        // reconnect re-delivers stay quiet.
        if (!sawBusyHere && s.emittedIdle) return out;
        s.emittedIdle = true;
        out.push(
          this.ev(
            s,
            "session.status",
            { state: "idle" },
            `opencode:${sessionID}:status:${evt.id}`,
          ),
        );
        return out;
      }
      case "question.asked": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        this.noteWork(s, out, `q:${p.id}`);
        out.push(
          this.ev(
            s,
            "question.asked",
            {
              request_id: p.id,
              questions: p.questions.map((q) => ({
                question: q.question,
                header: q.header,
                options: q.options.map((o) => ({ label: o.label, description: o.description })),
                multiple: q.multiple,
                custom: q.custom,
              })),
            },
            `opencode:${p.id}:question.asked`,
          ),
        );
        return out;
      }
      case "question.replied": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        out.push(
          this.ev(
            s,
            "question.resolved",
            { request_id: p.requestID, decision: "reply", answers: p.answers },
            `opencode:${p.requestID}:question.resolved`,
          ),
        );
        return out;
      }
      case "question.rejected": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        out.push(
          this.ev(
            s,
            "question.resolved",
            { request_id: p.requestID, decision: "reject" },
            `opencode:${p.requestID}:question.resolved`,
          ),
        );
        return out;
      }
      case "permission.asked": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        this.noteWork(s, out, `perm:${p.id}`);
        const shell = SHELL_PERMS.has(p.permission);
        const input: Record<string, unknown> = { ...p.metadata, patterns: p.patterns };
        if (shell) input.command = p.patterns.join("\n");
        out.push(
          this.ev(
            s,
            "permission.requested",
            {
              request_id: p.id,
              call_id: p.tool?.callID,
              tool: p.permission,
              input,
            },
            `opencode:${p.id}:permission.requested`,
          ),
        );
        return out;
      }
      case "permission.replied": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        out.push(
          this.ev(
            s,
            "permission.resolved",
            {
              request_id: p.requestID,
              decision: p.reply === "reject" ? "deny" : "allow",
              by: "user",
              scope: p.reply === "always" ? "always" : "once",
            },
            `opencode:${p.requestID}:permission.resolved`,
          ),
        );
        return out;
      }
      case "todo.updated": {
        if (!sessionID) return out;
        const { s, out: pre } = this.ensureSession(sessionID);
        out.push(...pre);
        const entries = evt.properties.todos
          .filter((t) => ["pending", "in_progress", "completed"].includes(t.status))
          .map((t) => ({
            content: t.content,
            status: t.status as "pending" | "in_progress" | "completed",
          }));
        out.push(
          this.ev(
            s,
            "plan.updated",
            { entries },
            `opencode:${sessionID}:plan:${Bun.hash(JSON.stringify(entries)).toString(36)}`,
          ),
        );
        return out;
      }
      default:
        return out;
    }
  }
}
