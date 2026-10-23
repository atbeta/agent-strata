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
