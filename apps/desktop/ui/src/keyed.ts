/**
 * The previous array when `next` holds the same keys in the same order.
 *
 * A `<For>` handed a fresh array of the same strings still walks every entry,
 * and every memo that reads the list wakes for nothing.
 */
export function stableKeys(prev: readonly string[] | undefined, next: readonly string[]): readonly string[] {
  if (prev && prev.length === next.length && prev.every((key, i) => key === next[i])) return prev;
  return next;
}
