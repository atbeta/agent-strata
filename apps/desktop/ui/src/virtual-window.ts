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

export function mountedRange(input: {
  count: number;
  top: number;
  viewport: number;
  overscan: number;
  /** Index of the row containing a pixel, from the prefix sum. `count` means past the end. */
  rowAt: (y: number) => number;
}): { first: number; last: number } {
  const { count, top, viewport, overscan, rowAt } = input;
  if (count <= 0) return { first: 0, last: -1 };
  const at = (y: number) => Math.min(count - 1, Math.max(0, rowAt(y)));
  const first = at(Math.max(0, top - overscan));
  const last = at(top + Math.max(0, viewport) + overscan);
  return { first, last: Math.max(first, last) };
}

/**
 * The index list for a window, reused when that window did not move.
 *
 * The range is read on every scroll frame. A fresh array each time woke the
 * row list and its measurement pass even though the same rows were already
 * mounted. The same reference means those subscribers stay quiet.
 */
export function stableIndexWindow(
  prev: readonly number[] | undefined,
  first: number,
  last: number,
): number[] {
  const count = last >= first ? last - first + 1 : 0;
  if (
    prev &&
    prev.length === count &&
    (count === 0 || (prev[0] === first && prev[count - 1] === last))
  ) {
    return prev as number[];
  }
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}
