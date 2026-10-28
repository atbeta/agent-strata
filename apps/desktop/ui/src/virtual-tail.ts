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
