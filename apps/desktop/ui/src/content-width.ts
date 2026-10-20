export const CONTENT_WIDTH_KEY = "strata.content-width";

/**
 * How wide the reading column may grow.
 *
 * The column used to be a hard `max-w-3xl` — 768px of text centered in
 * however much window the reader gave it. That is a comfortable line length
 * for prose, but a diff or a wide table has nothing to say for the room it
 * could have used, so the width is the reader's now, dragged from the
 * column's own edges and remembered here.
 */
export const CONTENT_W_DEFAULT = 768;
export const CONTENT_W_MIN = 480;
export const CONTENT_W_MAX = 1440;

/** Width of each reading-column hit target (`w-4`). */
export const SASH_HIT = 16;
/**
 * How far the hairline sits outside the text. The handle is centered on that
 * line, so the line is in the padding gutter instead of on the bubbles.
 */
export const SASH_OUTSET = 16;

export function sashEdge(contentWidth: number): string {
  const inset = contentWidth / 2 + SASH_HIT / 2 + SASH_OUTSET;
  return `max(0px, calc(50% - ${inset}px))`;
}

/** A real split already has its own divider. One pane, including a zoomed one, keeps the reading sash. */
export function showReadingSash(state: {
  mode: "single" | "multiplex";
  zoomed: boolean;
}): boolean {
  return state.mode !== "multiplex" || state.zoomed;
}

export function clampContentWidth(px: number): number {
  if (!Number.isFinite(px)) return CONTENT_W_DEFAULT;
  return Math.min(CONTENT_W_MAX, Math.max(CONTENT_W_MIN, Math.round(px)));
}

export function readContentWidth(storage: Pick<Storage, "getItem"> = localStorage): number {
  try {
    const raw = storage.getItem(CONTENT_WIDTH_KEY);
    if (raw !== null) return clampContentWidth(Number(raw));
  } catch {
    // Private mode can reject storage; the default still gives a usable column.
  }
  return CONTENT_W_DEFAULT;
}

export function writeContentWidth(px: number, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(CONTENT_WIDTH_KEY, String(Math.round(px)));
  } catch {
    // A session that cannot remember the width still has one right now.
  }
}
