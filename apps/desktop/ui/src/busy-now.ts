/**
 * Whether the reader is busy in a way that should outrank background parsing.
 *
 * Markdown warming exists so a row is ready before it is looked at. It is
 * never urgent, and it runs on the same thread as the pointer's shape and a
 * keystroke's echo. While the reader is typing, the keystroke comes first: a
 * queue that keeps parsing at full speed shows up as text that arrives a beat
 * after the key.
 *
 * A scroll is not one of those reasons. The rows ahead of the reader have to
 * be ready before the reader reaches them, and a row that arrives unprepared
 * parses on the frame it appears — its height moves the content under the
 * reader, and the backlog lands in one burst when the gesture ends. The
 * gesture therefore does not shrink the queue's budget; it only marks that
 * the reader is moving.
 */

/** How long after the last keystroke parsing still waits. */
export const TYPING_QUIET_MS = 400;

let lastTyping = -Infinity;

/** Note that the reader typed, so parsing yields for a moment. */
export function noteTyping(): void {
  lastTyping = performance.now();
}

/** Whether a queued parse should wait for the reader. */
export function parsingShouldWait(): boolean {
  return performance.now() - lastTyping < TYPING_QUIET_MS;
}
