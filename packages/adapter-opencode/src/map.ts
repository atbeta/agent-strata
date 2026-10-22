import type { Event, Part } from "@opencode-ai/sdk/v2";
import {
  REBUILDABLE_EVENT_TYPES,
  isStreamingSnapshot,
  makeEvent,
  type ContentBlock,
  type EventInput,
  type EventType,
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

/** A reasoning part's clock, kept only when the stamps are real instants. */
function thinkingTimes(time?: { start: number; end?: number }): {
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
export const OPENCODE_MAPPER_VERSION = "opencode-8";

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
  if (part.source && "path" in part.source) return { type: "file_ref", path: part.source.path };
  return { type: "file_ref", path: part.filename ?? (inline ? part.mime : part.url) };
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
  lastStreamAt?: number;
  /** parts a live delta has extended */
  streamed?: Set<string>;
  patchSeen?: Set<string>;
  /** files a successful edit or write in this message already reported, by pathKey */
  editedPaths?: Set<string>;
  /** compaction parts this message already emitted, by part.id */
  compactionSeen?: Set<string>;
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
   * Whether the backend currently says this session is generating.
   *
   * Upstream is the authority for this, but it is not reliable enough to be the
   * only source: a session that finished a turn after a permission was granted
   * never got a `session.idle`, and its `busy` stayed true forever. A session
   * that reads "running" while nothing is running is worse than one that reads
   * "running" a moment too long — it is a breathing dot on a dead conversation,
   * and it never corrects itself, so nobody can tell it apart from a real run.
   * This is what lets us notice the disagreement.
   */
  sawBusy?: boolean;
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
   * A run has been seen to finish. Held until real work arrives — a turn the
   * user sent — so that a claim still arriving on the global bus about a run
   * that ended cannot put the session back to running. See the `session.idle`
   * case for the measurement that made this necessary.
   */
  idleConfirmed?: boolean;
}

export class OpencodeMapper {
  sessions = new Map<string, SessionState>();
  /** assistant messages with text no snapshot has carried yet, by message id */
  private held = new Map<string, { s: SessionState; m: MsgState }>();

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
      { turn_id: m.parentID, msg_id: messageID, partial: true, content },
      `opencode:${messageID}:assistant.partial:${Bun.hash(JSON.stringify(content)).toString(36)}`,
      // A snapshot has no clock of its own; the ingest clock would make it the
      // newest thing in a replayed session and reorder the session list.
      sourceTime(m.created ?? s.updated),
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

  ev(
    s: SessionState,
    kind: EventInput["type"],
    data: unknown,
    id?: string,
    ts?: string,
  ): EventInput {
    const base = makeEvent({
      session_id: s.casfId,
      source: { backend: "opencode", native_id: s.sessionID },
      type: kind,
      data,
      ...(ts ? { ts } : {}),
    } as EventInput);
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
      s.liveMsgs?.clear();
      // The same retirement a real idle does. Leaving the open message held
      // meant the stream flush published one more partial after this idle, and
      // the composer treats a partial as a run — the stop button came back on
      // a session that had just been declared finished, and abort had nothing
      // left to stop.
      for (const [msgID, held] of this.held) if (held.s === s) this.held.delete(msgID);
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
   * the backend only claimed the session — nothing has finished, so the session
   * may be a run that is starting, and it has to be quiet for a whole window
   * before it can be called over.
   *
   * `key` names what queued it, so a session corrected twice under different
   * evidence does not collapse into one event id and replay as already seen.
   */
  private pendingSettles = new Map<SessionState, { key: string; afterCompletion: boolean }>();

  private queueSettle(s: SessionState, key: string, afterCompletion: boolean): void {
    if (!s.sawBusy) return;
    // A completion is the stronger reason to be here; a claim queued behind it
    // must not downgrade it into waiting for the whole quiet window.
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
        // owed before a claim alone can be called over.
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

  private ensureSession(sessionID: string): { s: SessionState; out: EventInput[] } {
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
    if (!s.started) {
      s.started = true;
      s.startedBlind = true;
      out.push(
        this.ev(
          s,
          "session.started",
          { workspace: this.opts.directory ?? "unknown" },
          `opencode:${sessionID}:session.started`,
        ),
      );
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
    const props = "properties" in evt ? evt.properties : undefined;
    const sessionID =
      props && "sessionID" in props ? (props.sessionID as string) : undefined;
    if (sessionID) {
      const known = this.sessions.get(sessionID);
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
        const { s, out: pre } = this.ensureSession(p.sessionID);
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
        const meta = this.syncMeta(s, p.info, already ? "updated" : "created");
        if (meta) out.push(meta);
        return out;
      }
      case "session.updated": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
        const meta = this.syncMeta(s, p.info, "updated");
        if (meta) out.push(meta);
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
        // A message is real work, and real work is what lifts a confirmed idle.
        // A claim is not: the global bus keeps sending one about a run that has
        // already ended, and treating that as the start of a new one is what put
        // a finished session back to running for as long as the project kept
        // working. See the `session.idle` case.
        s.idleConfirmed = false;
        if (info.role === "user") {
          s.pendingUserMsgs.add(info.id);
          return out;
        }
        if (info.role === "assistant") {
          m.parentID = info.parentID;
          (s.liveMsgs ??= new Map()).set(info.id, info.parentID);
          this.flushUser(s, out, info.parentID);
          for (const t of m.toolParts.values()) {
            const part = t.deferred;
            if (!part) continue;
            t.deferred = undefined;
            out.push(...this.toolEvents(s, m, part, t));
          }
          if (info.time.completed !== undefined && !m.emittedAssistant) {
            m.emittedAssistant = true;
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
          else m.parts.set(part.id, { type: "text", text: part.text });
        } else if (part.type === "reasoning") {
          m.parts.set(part.id, { type: "thinking", text: part.text, ...thinkingTimes(part.time) });
        } else if (part.type === "file") {
          m.parts.set(part.id, fileBlock(part));
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
              { message_id: part.messageID, auto: part.auto },
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
        if (!s || !m || !block || (block.type !== "text" && block.type !== "thinking")) return out;
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
        const idle =
          evt.type === "session.idle" || evt.properties.status.type === "idle";
        /**
         * OpenCode serves two buses and they do not agree. `/event?directory=`
         * follows one project and `/global/event` follows every project; a
         * desktop session list has to take the global one or it would only know
         * about the project it happened to be launched in. Measured on a live
         * server, one run in D:\Code\lector read:
         *
         *   DIR     status busy
         *   GLOBAL  status busy
         *   ...
         *   DIR     status idle
         *   DIR     idle   IDLE
         *   GLOBAL  status busy     <- the run is over and it keeps saying busy
         *
         * The global bus carries the state of a session that has already
         * finished, so the last state to arrive is not the state of the run. A
         * projection that is correct about every event it was given still reads
         * idle forever while its tools are visibly working.
         *
         * So the buses are not interchangeable. An idle is taken as final, and
         * only real work lifts it — a turn the user sent, a message the model
         * produced. A bare claim does not, because a bare claim is exactly what
         * the global bus keeps re-sending about a run that ended. The global
         * bus keeps discovering sessions; it is no longer allowed to end them.
         */
        if (idle) {
          for (const msgID of [...s.pendingUserMsgs]) this.flushUser(s, out, msgID);
          // a message that never finished is retired by the overlay at idle; a
          // late frame for it would bring it back
          for (const [msgID, held] of this.held) if (held.s === s) this.held.delete(msgID);
          s.sawBusy = false;
          s.liveMsgs?.clear();
          s.idleConfirmed = true;
        } else if (s.idleConfirmed) {
          // Stale: this run is over. Dropping it is what stops the last event to
          // arrive from being the one the projection keeps.
          return out;
        } else {
          // Remember that the backend claimed work, so a later completion with
          // no idle behind it is something we can correct rather than guess at.
          s.sawBusy = true;
          // Arm the correction here, on the claim, rather than waiting for a
          // message to complete. Every earlier version armed it from the
          // completion, which made the correction depend on the run producing
          // one — and the runs that most need correcting are the ones that do
          // not: a turn the reader aborted, a provider that dropped mid-answer,
          // a run the backend discarded. Those never complete a message, so
          // nothing queued a settle, `settleTimerMs()` answered undefined and
          // no timer existed: `busy` then outlived the session and the
          // composer queued every message sent to it from then on.
          this.queueSettle(s, `busy:${evt.id}`, false);
        }
        out.push(
          this.ev(
            s,
            "session.status",
            { state: idle ? "idle" : "busy" },
            `opencode:${sessionID}:status:${evt.id}`,
          ),
        );
        return out;
      }
      case "question.asked": {
        const p = evt.properties;
        const { s, out: pre } = this.ensureSession(p.sessionID);
        out.push(...pre);
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
