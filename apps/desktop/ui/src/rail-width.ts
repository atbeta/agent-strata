export const RAIL_WIDTH_KEY = "strata.rail-width";

/**
 * How much of the window the rail may take.
 *
 * The rail used to be `w-72` on one tab and `min(600px, 48vw)` on the rest, so
 * switching tabs resized the panel and re-wrapped the transcript beside it —
 * at a 954px window an assistant reply re-rendered one character per line.
 * The width is the reader's now, and nothing but the window moves it.
 */
export const RAIL_CEILING = 0.62;
export const RAIL_MIN = 280;
export const RAIL_MAX = 900;
/** No stored width yet: wide enough for a unified diff, narrow enough to talk over. */
export const RAIL_DEFAULT = 420;

/**
 * A width the reader can live with. Past `RAIL_CEILING` the transcript beside it
 * stops being readable, so a width chosen on a wide window still yields on a
 * narrow one rather than running it off the edge.
 */
export function clampRailWidth(px: number, viewport: number): number {
  const ceiling = Math.max(RAIL_MIN, Math.round(viewport * RAIL_CEILING));
  const high = Math.min(RAIL_MAX, ceiling);
  if (!Number.isFinite(px)) return Math.min(RAIL_DEFAULT, high);
  return Math.min(high, Math.max(RAIL_MIN, Math.round(px)));
}

export function readRailWidth(viewport: number, storage: Pick<Storage, "getItem"> = localStorage): number {
  try {
    const raw = storage.getItem(RAIL_WIDTH_KEY);
    if (raw !== null) return clampRailWidth(Number(raw), viewport);
  } catch {
    // Private mode can reject storage; the default still gives a usable rail.
  }
  return clampRailWidth(RAIL_DEFAULT, viewport);
}

export function writeRailWidth(px: number, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(RAIL_WIDTH_KEY, String(Math.round(px)));
  } catch {
    // A session that cannot remember the width still has one right now.
  }
}