/**
 * How much of a freshly parsed tail is already on screen.
 *
 * A streaming reply is re-parsed on every token, but almost all of what comes
 * back is the string that was there a frame ago. Removing the tail and
 * appending the new one anyway throws those nodes away: the paragraph the
 * reader is looking at is destroyed and rebuilt to hold one more word, which
 * blinks, drops the selection, reloads the images inside it and moves the
 * scroll anchor.
 *
 * So the tail is reconciled rather than replaced. The walk stops at the first
 * difference because the change is at the end — text is appended, so the nodes
 * before it are the ones that did not move — and a tail is a handful of blocks,
 * which makes the comparison cheaper than the work it avoids.
 */
export function samePrefixCount<T>(
  existing: readonly T[],
  incoming: readonly T[],
  equal: (a: T, b: T) => boolean,
): number {
  const limit = Math.min(existing.length, incoming.length);
  let same = 0;
  while (same < limit && equal(existing[same]!, incoming[same]!)) same += 1;
  return same;
}
