/**
 * Which rows the transcript list mounts.
 *
 * The window is a pixel budget: overscan above, the viewport, and overscan
 * below, turned into row indexes through the prefix sum. A row cap on top of
 * that was tried and made scrolling worse. The cap unmounted rows the reader
 * was about to reach, and mounting them again parsed their markdown on the
 * scroll frame — the hitch the cap was meant to remove.
 *
 * What actually bounds the count is the row estimate. A guess far below a
 * real turn buys several times too many rows for the same pixels. Keep the
 * estimate near a real turn; do not trim the window after the fact.
 *
 * A scroll position carried over from another session can be past this one's
 * end. `rowAt` answers `count` there, and a start past the end mounts nothing,
 * which is the blank pane this list must not draw. The indexes are clamped to
 * the last row.
 */

export interface Range {
  first: number;
  last: number;
}

export function mountedRange(input: {
  count: number;
  top: number;
  viewport: number;
  overscan: number;
  /** Index of the row containing a pixel, from the prefix sum. `count` means past the end. */
  rowAt: (y: number) => number;
}): Range {
  const { count, top, viewport, overscan, rowAt } = input;
  if (count <= 0) return { first: 0, last: -1 };
  const at = (y: number) => Math.min(count - 1, Math.max(0, rowAt(y)));
  const first = at(Math.max(0, top - overscan));
  const last = at(top + Math.max(0, viewport) + overscan);
  return { first, last: Math.max(first, last) };
}

/**
 * The rows of `ahead` outside `visible`, nearest the view first, alternating
 * above and below — the order the reader reaches them in either direction.
 */
export function aheadOrder(visible: Range, ahead: Range): number[] {
  const out: number[] = [];
  let up = visible.first - 1;
  let down = visible.last + 1;
  while (up >= ahead.first || down <= ahead.last) {
    if (up >= ahead.first) out.push(up--);
    if (down <= ahead.last) out.push(down++);
  }
  return out;
}

/**
 * How many rows may be warming at once.
 *
 * A fling adds every row the window crosses to the warm queue. Each heavy row
 * costs more than one frame's budget, so a long gesture could leave dozens of
 * parses behind it: the queue drained for seconds after the scrolling stopped,
 * and typing in the composer competed with markdown that was no longer needed.
 * Keeping a small number in flight bounds that tail; rows beyond it are warmed
 * when the reader scrolls nearer to them.
 */
export const WARM_AHEAD = 6;
