/**
 * A prompt is stored where it was sent, then again under a content-hash id
 * when the session is read back. Both share a turn id. The bar stays on the
 * earlier seq; the later copy only contributes text, so the re-read does not
 * paint a second row of prompts at the end of the strip.
 */
export function mergeUserBar(
  prev: { seq: number; ts: string; preview: string } | undefined,
  next: { seq: number; ts: string; preview: string },
): { seq: number; ts: string; preview: string } {
  const spoken = (preview: string) => (preview === "message" ? "" : preview);
  if (!prev) return next;
  const nextText = spoken(next.preview);
  const prevText = spoken(prev.preview);
  const preview = nextText.length >= prevText.length && nextText ? next.preview : prev.preview;
  if (next.seq < prev.seq) return { seq: next.seq, ts: next.ts, preview };
  return { seq: prev.seq, ts: prev.ts, preview };
}

/** How far the window can move. A zero viewport means it has not been measured. */
export function traceMaxOffset(content: number, view: number): number {
  if (view <= 0) return 0;
  return Math.max(0, content - view);
}

/** One step is most of a viewport, so the page that was showing stays partly in view. */
export function tracePage(content: number, view: number, offset: number, dir: -1 | 1): number {
  const max = traceMaxOffset(content, view);
  const step = Math.max(48, Math.round(view * 0.8));
  return Math.min(Math.max(0, offset + dir * step), max);
}

/** Put the clicked point of the whole session in the middle of the window. */
export function traceJump(content: number, view: number, ratio: number): number {
  const max = traceMaxOffset(content, view);
  const x = Math.min(Math.max(ratio, 0), 1) * content;
  return Math.min(Math.max(0, x - view / 2), max);
}

/**
 * Pixel range of bars worth mounting. The anchor snaps to a bucket so a small
 * pan does not rebuild the list; one bucket of bars stays mounted on each side.
 */
export function traceWindow(offset: number, view: number, bucket = 320): { start: number; end: number } {
  const size = bucket > 0 ? bucket : 320;
  const o = Math.max(0, offset);
  const anchor = Math.floor(o / size) * size;
  return { start: Math.max(0, anchor - size), end: anchor + Math.max(0, view) + size };
}
