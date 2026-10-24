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
  "permission.requested",
  "permission.resolved",
  "question.asked",
  "question.resolved",
]);

export function changesSessionList(type: string | undefined): boolean {
  return type !== undefined && LIST_EVENTS.has(type);
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
