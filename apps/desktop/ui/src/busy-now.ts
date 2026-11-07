/**
 * Whether the reader is busy in a way that should outrank background parsing.
 *
 * Markdown warming exists so a row is ready before it is looked at. It is
 * never urgent, and it runs on the same thread as the pointer's shape and a
 * keystroke's echo. While the reader is scrolling or typing, those come
 * first: a queue that keeps parsing during a gesture shows up as a cursor
 * that changes shape late and text that arrives a beat after the key.
 *
 * The sources are predicates rather than a boolean because they have separate
 * lifetimes: a gesture is owned by the transcript, typing by the composer, and
 * a pane that unmounts must be able to withdraw its own reason without
 * clearing someone else's.
 */
const sources = new Set<() => boolean>();

/** How long after the last keystroke parsing still waits. */
export const TYPING_QUIET_MS = 400;

let lastTyping = -Infinity;

/** Note that the reader typed, so parsing yields for a moment. */
export function noteTyping(): void {
  lastTyping = performance.now();
}

/** Hold background parsing while `busy` is true. Returns the withdrawal. */
export function holdParsingWhile(busy: () => boolean): () => void {
  sources.add(busy);
  return () => {
    sources.delete(busy);
  };
}

/** Whether a queued parse should wait for the reader. */
export function parsingShouldWait(): boolean {
  if (performance.now() - lastTyping < TYPING_QUIET_MS) return true;
  for (const busy of sources) if (busy()) return true;
  return false;
}
