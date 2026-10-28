/**
 * How many rows the window mounts.
 *
 * The window used to be a pixel budget: `overscan` above, the viewport, and
 * `overscan` below, converted to row indices through the prefix sum. That is
 * right once rows have been measured and wrong on the first frame, when every
 * row is still at `estimate`.
 *
 * Measured on a real session, the estimate is small against what a turn actually
 * renders — 100px against an average of ~352px. The budget is in pixels, so an
 * estimate that low buys three times as many rows as the budget meant to pay
 * for: 18 mounted instead of 6. Every one of those rows parses its markdown
 * synchronously on mount, so the first frame of a long session spent ~185ms in
 * one task instead of the ~60ms the same window costs once heights are known.
 *
 * A long task is not only a slow first paint. Hover and cursor hit-testing run
 * on the same thread, so while it is blocked the pointer over the transcript's
 * outline never becomes a pointer and never updates — and the moment the thread
 * frees, the pending pointer work lands at once, which is the jump a reader sees
 * after scrolling.
 *
 * So the window is bounded in rows, which is the unit the work is actually done
 * in. The bound can only trim overscan: the viewport itself is always covered,
 * because a cap that cut into it would leave the pane blank below the fold, and
 * a blank pane is far worse than the frame it saves.
 */

/**
 * The most rows that may be mounted at once.
 *
 * Not a tuning knob so much as a ceiling on the damage a wrong estimate can do.
 * With the viewport covered first, the floor is `viewport / estimate` rows plus
 * whatever overscan survives the cap; this stops the below-viewport overscan
 * from adding a third again on top of that.
 */
export const MAX_MOUNTED_ROWS = 12;

/**
 * The first and last row index to mount, inclusive.
 *
 * `rowAt` answers "which row contains this pixel". `covering` is the last row a
 * reader can actually see, and is a floor for the result: the viewport is drawn
 * whatever the budget says. `padded` is where the pixel budget would end, and is
 * the ceiling the row cap trims. The answer is the tighter of the two, never
 * below `covering`.
 *
 * Returns an empty range when the list is empty, and never a range whose start
 * is past its end.
 */
export function mountedRange(input: {
  count: number;
  top: number;
  viewport: number;
  overscan: number;
  maxRows?: number;
  /** Index of the row containing a pixel, from the prefix sum. */
  rowAt: (y: number) => number;
}): { first: number; last: number } {
  const { count, top, viewport, overscan, rowAt } = input;
  if (count <= 0) return { first: 0, last: -1 };
  const maxRows = Math.max(1, input.maxRows ?? MAX_MOUNTED_ROWS);
  const at = (y: number) => Math.min(count - 1, Math.max(0, rowAt(y)));

  // The first row the reader can see, and the last one. Both are floors: the
  // area that has to be painted is not something a wrong estimate may shrink.
  const topRow = at(top);
  const covering = at(top + viewport);

  // Clamped to the last row, not merely to `>= 0`. A scroll position carried
  // over from another session can be past the end of this one, and `rowAt`
  // answers `count` there — a start past the end is a window that renders
  // nothing at all, which is the empty pane this list must never draw.
  const start = at(Math.max(0, top - overscan));
  const padded = at(top + viewport + overscan);

  // Take the pixel budget, but never fewer rows than the cap allows.
  let last = Math.min(padded, Math.max(covering, start + maxRows - 1));
  // Then trim the excess off the *start*, which is where overscan above the
  // viewport lives. Trimming `last` instead would cap nothing at all: the span
  // is what costs, and it would keep growing with the overscan above.
  let first = Math.max(start, last - maxRows + 1);

  // The viewport wins over the cap, in both directions. A list whose rows are
  // short enough needs more than `maxRows` just to fill the pane, and a blank
  // pane is worse than the frame the cap would save.
  first = Math.min(first, topRow);
  last = Math.max(last, covering);

  return { first, last: Math.max(first, last) };
}
