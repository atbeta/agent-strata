/**
 * The events that can actually move a row while a sync is running.
 *
 * A sync appends every message, tool call and file change it imports, and the
 * old path reread `/sessions` for each of them. That projection is what made
 * the overview's token total climb message by message and put "刚刚" on a row
 * whose real timestamp had not been imported yet.
 *
 * Structural events still refresh the list: a new session, a deleted one, a
 * status change, or something waiting on the reader. `session.updated` is
 * deliberately absent — a sync emits it once per imported session, and its
 * title/workspace can wait for the single reread at the finish.
 */
const LIST_EVENTS = new Set([
  "session.started",
  "session.deleted",
  "session.status",
  "session.ended",
  "session.error",
  "permission.requested",
  "permission.resolved",
  "question.asked",
  "question.resolved",
]);

export function changesSessionList(type: string | undefined): boolean {
  return type !== undefined && LIST_EVENTS.has(type);
}

/**
 * The ticks the service no longer backs.
 *
 * A tick is the reader's record that a sync is running for that connection.
 * The service keeps its own record, and it is the authority: the tick can
 * outlive the event that would have cleared it, because that event rides the
 * stream and a stream that breaks mid-sync never delivers it. A connection
 * the service calls idle, or one it no longer lists at all, has no sync
 * behind it.
 *
 * A connection whose state is unknown is left alone. The service always
 * answers with one of the three, but a stale tick held for good is a milder
 * fault than a live one cleared early.
 */
export function staleSyncTicks(
  ticks: ReadonlyMap<string, unknown>,
  connections: readonly { id: string; sync?: "starting" | "syncing" | "idle" }[],
): string[] {
  return [...ticks.keys()].filter((id) => {
    const conn = connections.find((c) => c.id === id);
    // A connection the service no longer lists is gone, and so is its sync.
    if (!conn) return true;
    // A connection whose state is unknown is left alone: the service always
    // answers with one of the three, and a tick held for good is a milder
    // fault than a live one cleared early.
    return conn.sync === "idle";
  });
}

/**
 * Whether the background pull may run now.
 *
 * A pull asks every backend for its whole project list and session tree. The
 * timer and the focus listener both call it, and neither knows whether the
 * window is on screen; a hidden window pulls again when it comes back.
 */
export function pullAllowed(state: { ready: boolean; syncing: boolean; hidden: boolean }): boolean {
  return state.ready && !state.syncing && !state.hidden;
}

/**
 * Whether an event is about a background process rather than the session.
 *
 * `dev.*` events carry a `session_id`, because that is what owns the process,
 * and they arrive on the same stream as everything else. That made them look
 * like session activity to every reader that keyed on the id: a dev server
 * writing a line re-fetched the session list and re-projected the transcript,
 * so a running server kept the view from ever settling.
 *
 * A dev server's output is not a turn. It is not a status change, it does not
 * move a row, and the transcript is exactly as it was.
 */
export function isDevEvent(type: string | undefined): boolean {
  return type !== undefined && type.startsWith("dev.");
}
