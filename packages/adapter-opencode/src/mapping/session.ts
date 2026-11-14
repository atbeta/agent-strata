import { makeEvent, type EventInput, type SessionDiagnostic } from "@agent-strata/schema";
import { sourceTime, type MsgState } from "./model";

export interface SessionState {
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
   * completed nothing. A session therefore stays "running" until the backend
   * says otherwise; the two things that can still correct it are a reconnect
   * (`reconcileIdle`, which asks the server) and the reader's own stop.
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
   * belong to.
   *
   * Per message rather than a bare counter, because a turn is several assistant
   * messages and they arrive in order: the second is created after the first
   * has completed. Kept so idle can close every open message at once, and so a
   * completion can retire its own entry.
   */
  liveMsgs?: Map<string, string | undefined>;
  /**
   * Questions and permissions the backend is still holding open, by request
   * id. While one is outstanding the run is parked on the reader, so the mapper
   * does not close it out — the answer is what moves it.
   */
  awaiting?: Set<string>;
  /** last title / directory / archive we emitted, so cost-only session.updated stays quiet */
  metaSeen?: boolean;
  title?: string;
  workspace?: string;
  archived?: boolean;
  parent?: string;
  /** last revert message id we emitted; cleared after revert: null */
  revertMessageID?: string;
  /**
   * Whether this mapper generation has announced an idle for the session.
   *
   * The ledger is memory: a restart or a reconnect rebuilds it, and the store's
   * projection keeps whatever `busy` the previous generation wrote. A guard that
   * only trusted its own memory would refuse the very idle that clears it.
   */
  emittedIdle?: boolean;
  /**
   * The plan as last emitted, and how many distinct ones this generation sent.
   *
   * The event id cannot be a hash of the content alone: a plan that goes
   * A -> B -> A would reuse A's id, and the store keeps an existing id for its
   * timestamp alone — so the second A is dropped and the projection stays on B.
   * Measured on the abort path, which is the ordinary way to get there: a run
   * is stopped, the table is cleared, the next run writes the same list again,
   * and the strip would show the empty one. A counter that moves only when the
   * list changes gives a fresh id per change while an unchanged re-delivery
   * still dedups.
   */
  planFingerprint?: string;
  planSeq?: number;
}

export function makeSessionEvent(
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

export function adoptSession(sessions: Map<string, SessionState>, sessionID: string): SessionState {
  const existing = sessions.get(sessionID);
  if (existing) return existing;
  const s: SessionState = {
    sessionID,
    casfId: `opencode:${sessionID}`,
    started: false,
    messages: new Map(),
    pendingUserMsgs: new Set(),
  };
  sessions.set(sessionID, s);
  return s;
}

export function ensureSessionState(
  sessions: Map<string, SessionState>,
  sessionID: string,
  directory?: string,
  clock?: number,
): { s: SessionState; out: EventInput[] } {
  const out: EventInput[] = [];
  const s = adoptSession(sessions, sessionID);
  if (clock != null && s.updated == null) s.updated = clock;
  if (!s.started) {
    s.started = true;
    const at = sourceTime(s.updated);
    if (at) {
      out.push(
        makeSessionEvent(
          s,
          "session.started",
          { workspace: directory ?? "unknown" },
          `opencode:${sessionID}:session.started`,
          at,
        ),
      );
    } else {
      s.startedBlind = true;
      out.push(
        makeSessionEvent(
          s,
          "session.started",
          { workspace: directory ?? "unknown" },
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
        makeSessionEvent(
          s,
          "session.started",
          { workspace: directory ?? "unknown" },
          `opencode:${sessionID}:session.started`,
          at,
        ),
      );
    }
  }
  return { s, out };
}

export interface SessionInfo {
  title?: string;
  directory?: string;
  parentID?: string;
  time?: { updated?: number; created?: number; archived?: number };
  revert?: { messageID: string };
}

export function syncSessionMeta(
  s: SessionState,
  info: SessionInfo,
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
  return makeSessionEvent(
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
