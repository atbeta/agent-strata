/**
 * Is this scroller at the end of the list?
 *
 * The transcript's list follows its tail — new turns, rows finally being
 * measured, a sent message landing — as long as the reader has not deliberately
 * scrolled away. That decision is made from these three numbers and nowhere
 * else, because `scrollHeight` is a moving target while measurements land.
 *
 * It used to be `Math.abs(scrollTop + viewport - extent) < TOLERANCE`, which is
 * wrong at both ends and fatally wrong on mount. A list that fits inside its
 * scroller has `scrollTop + viewport > extent`: the distance is positive, and
 * not small, so the reader sitting at the very bottom was recorded as having
 * left the tail. Every session opened on its first turn instead of its last,
 * and the turn a reader had just sent went on below the fold with a button as
 * the only way to it.
 *
 * Overscroll is the other end: a scroller past its extent is still at the end.
 * Reaching the end, or passing it, is the whole condition — no distance to
 * compare, and nothing for a rounding error to be on the wrong side of.
 */
export const TAIL_TOLERANCE = 96;

export function atTail(
  scrollTop: number,
  viewport: number,
  extent: number,
  tolerance = TAIL_TOLERANCE,
): boolean {
  return scrollTop + viewport >= extent - tolerance;
}

/**
 * Air above a row the reader jumped to.
 *
 * Landing a row flush against the top edge of the scroller is technically
 * correct and reads as a mistake: the turn is butted against the title strip
 * with no gap, so there is nothing saying where the jump ended. Measured on a
 * real jump, the row's top came out at exactly 0 against the scroller's box.
 *
 * The gap is deliberately smaller than the container's own `py-4`, because the
 * scroller has already spent that padding by the time a jump lands — `origin()`
 * folds the host's position into the target, so the padding is behind the
 * viewport, not in front of the row.
 */
export const JUMP_GAP = 12;

/**
 * Where to put the scroller so that row `top` lands `gap` below the viewport's
 * top edge.
 *
 * Kept as a function of the row's real top rather than folded into the caller,
 * because the re-anchor loop in `jumpToTurn` re-derives this on every frame as
 * rows finish measuring. Getting the sign of the correction wrong is what makes
 * a jump drift instead of settle, so it is worth stating once, here, where a
 * test can hold it.
 */
export function scrollTopForRow(top: number, gap = JUMP_GAP): number {
  return Math.max(0, top - gap);
}

/**
 * Centre a row without trusting the estimate.
 *
 * `clientHeight - estimate` is the wrong half of the subtraction: the estimate is
 * a guess about a row nobody has measured yet, and the row that is about to be
 * measured is exactly the one whose guess is least likely to hold. A 100px
 * estimate against a turn that renders at 1034px scrolls to a position that is
 * 467px off, and the reader lands mid-row with a third of it off-screen.
 *
 * `rowHeight` is the real measured height whenever the row is mounted, which it
 * is for every jump a reader makes by clicking something on screen.
 */
export function scrollTopToCentreRow(
  top: number,
  rowHeight: number,
  viewport: number,
  extent: number,
): number {
  const centred = top - Math.max(0, (viewport - rowHeight) / 2);
  // A row taller than the viewport cannot be centred, and a target near the
  // bottom cannot scroll far enough to centre at all. Clamping to the reachable
  // range is what stops a jump from silently doing nothing.
  return Math.max(0, Math.min(centred, Math.max(0, extent - viewport)));
}

