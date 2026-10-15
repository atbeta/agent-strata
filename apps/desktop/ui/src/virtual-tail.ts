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
