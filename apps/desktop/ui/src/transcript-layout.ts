/**
 * Where a transcript was, so the next one can open there.
 *
 * Focusing a pane mounts a new list. The list it replaces already measured
 * every row on screen and already knew which row the reader was in. Neither
 * fact used to leave with it: the new list guessed 100px for every row, so the
 * turns stacked on top of each other, and it scrolled to a pixel offset taken
 * from a coordinate system that no longer existed. Measurements then arrived
 * and the column jumped into place.
 *
 * Heights are kept per pane and session. A split can make the same
 * conversation narrower in one pane than the other, and a narrower column
 * wraps taller. The reading position is a row plus how far into that row the
 * viewport has moved, which stays meaningful when a row above it changes
 * height.
 */

/** Height of a row nobody has measured. Shared with every transcript list. */
export const ROW_ESTIMATE = 100;

/** Space between rows, included after every row the way the list's prefix sum does. */
export const ROW_GAP = 32;

const EPS = 0.5;

const heights = new Map<string, Map<string, number>>();
const readings = new Map<string, Reading>();

export type Reading =
  | { pinned: true }
  | { pinned: false; turnId: string; offset: number };

export function layoutKey(paneId: string, sessionId: string): string {
  return `${paneId}:${sessionId}`;
}

export function readRowHeights(key: string): ReadonlyMap<string, number> {
  return heights.get(key) ?? EMPTY;
}

export function writeRowHeight(key: string, turnId: string, height: number): void {
  if (!turnId || !height) return;
  let rows = heights.get(key);
  if (!rows) {
    rows = new Map();
    heights.set(key, rows);
  }
  const prev = rows.get(turnId);
  if (prev !== undefined && Math.abs(prev - height) < EPS) return;
  rows.set(turnId, height);
}

export function rememberReading(key: string, reading: Reading): void {
  readings.set(key, reading);
}

export function recallReading(key: string): Reading | undefined {
  return readings.get(key);
}

const EMPTY: ReadonlyMap<string, number> = new Map();

/**
 * Prefix sums of row height + gap. Index n is the top of row n, and the last
 * entry is the extent of the list. This is the same sum the virtual list
 * paints with; a second formula here would restore the reader to a place the
 * list does not render.
 */
export function prefixOffsets(
  ids: readonly string[],
  known: ReadonlyMap<string, number>,
  estimate: number,
  gap: number,
): Float64Array {
  const out = new Float64Array(ids.length + 1);
  let acc = 0;
  for (let i = 0; i < ids.length; i++) {
    out[i] = acc;
    acc += (known.get(ids[i]!) ?? estimate) + gap;
  }
  out[ids.length] = acc;
  return out;
}

/** Index of the row containing pixel `y`, or `ids.length` when y is past the end. */
export function rowAtOffset(offsets: Float64Array, y: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1]! <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function anchorFromOffsets(
  scrollTop: number,
  offsets: Float64Array,
  idAt: (index: number) => string | undefined,
): { turnId: string; offset: number } | undefined {
  const count = offsets.length - 1;
  if (count <= 0) return undefined;
  let i = rowAtOffset(offsets, Math.max(0, scrollTop));
  if (i >= count) i = count - 1;
  const turnId = idAt(i);
  if (!turnId) return undefined;
  return { turnId, offset: scrollTop - offsets[i]! };
}

export function anchorAt(
  scrollTop: number,
  ids: readonly string[],
  known: ReadonlyMap<string, number>,
  estimate: number,
  gap: number,
): { turnId: string; offset: number } | undefined {
  return anchorFromOffsets(scrollTop, prefixOffsets(ids, known, estimate, gap), (i) => ids[i]);
}

/** Scroll position that puts `anchor` the same distance into its row. Missing row: undefined. */
export function scrollTopForAnchor(
  anchor: { turnId: string; offset: number },
  ids: readonly string[],
  known: ReadonlyMap<string, number>,
  estimate: number,
  gap: number,
): number | undefined {
  const i = ids.indexOf(anchor.turnId);
  if (i < 0) return undefined;
  const offsets = prefixOffsets(ids, known, estimate, gap);
  return Math.max(0, offsets[i]! + anchor.offset);
}

/** Scroll position that pins the viewport to the end of the list. */
export function scrollTopForTail(
  ids: readonly string[],
  known: ReadonlyMap<string, number>,
  estimate: number,
  gap: number,
  viewport: number,
): number {
  const end = prefixOffsets(ids, known, estimate, gap)[ids.length] ?? 0;
  return Math.max(0, end - Math.max(0, viewport));
}

/**
 * Where the list should open.
 *
 * A stored reading wins. The pixel fallback is only for a pane that has never
 * recorded one — a pixel taken while the list was still guessing heights is
 * what slides the column when the real heights arrive.
 */
/**
 * The reading to store for this scroll position.
 *
 * Pinned forgets the pixel: the tail is wherever the list ends next time.
 * Otherwise the row under the viewport's top edge is the memory, and the
 * pixel is only how far into that row.
 */
export function readingFromScroll(
  key: string,
  scrollTop: number,
  pinned: boolean,
  ids: readonly string[],
): Reading {
  if (pinned || ids.length === 0) return { pinned: true };
  const anchor = anchorAt(scrollTop, ids, readRowHeights(key), ROW_ESTIMATE, ROW_GAP);
  if (!anchor) return { pinned: true };
  return { pinned: false, turnId: anchor.turnId, offset: anchor.offset };
}

export function placeReading(input: {
  key: string;
  ids: readonly string[];
  viewport: number;
  fallback?: { scrollTop: number; pinned: boolean };
}): { scrollTop: number; pinned: boolean } {
  const known = readRowHeights(input.key);
  const reading = recallReading(input.key);
  if (reading?.pinned === false) {
    const top = scrollTopForAnchor(reading, input.ids, known, ROW_ESTIMATE, ROW_GAP);
    if (top !== undefined) return { pinned: false, scrollTop: top };
  }
  if (reading?.pinned === true || !input.fallback || input.fallback.pinned) {
    // A viewport that has not been measured yet makes "the tail" meaningless:
    // without it the tail is the whole extent, and that extent is guessed from
    // however many turns happen to be loaded. Opening on that number put the
    // reader 396px into a conversation 274,907px tall — the first turn of the
    // session they had just opened. Being pinned is not a pixel to restore; the
    // list follows the tail itself, so say so and let it.
    if (input.viewport <= 0) return { pinned: true, scrollTop: 0 };
    return {
      pinned: true,
      scrollTop: scrollTopForTail(input.ids, known, ROW_ESTIMATE, ROW_GAP, input.viewport),
    };
  }
  return { pinned: false, scrollTop: input.fallback.scrollTop };
}

/**
 * Scroll offset that keeps the tail against the bottom of the viewport.
 *
 * A scroller that has not been laid out reports a height of 0. Pinning against
 * that parks the reader at the extent, and the frame that finally has a height
 * pulls them back by the whole viewport.
 */
export function pinScroll(total: number, clientHeight: number): number | undefined {
  if (clientHeight <= 0) return undefined;
  return Math.max(0, total - clientHeight);
}
