/**
 * Holding a row still between fetches.
 *
 * The sidebar refetches on a timer, on window focus, and after any backend
 * event, and every one of those hands back freshly parsed objects. `<For>`
 * compares its items by reference, so new objects meant every row in the list
 * was disposed and built again several times a minute — and everything a row
 * was holding went with it: the title being typed into, the delete waiting on
 * its second click, the menu someone had just opened. A refetch landing in the
 * middle of a rename deleted what was being renamed.
 *
 * Reusing the previous object when nothing in it actually changed is what stops
 * that. Equality is decided by value rather than by a list of known fields, so
 * a backend that grows a new field still updates the row it changed.
 */

/** Value equality over the plain data these rows are: objects, arrays, primitives. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameValue(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  return keys.every((k) => k in bo && sameValue(ao[k], bo[k]));
}

/**
 * `next`, with every entry that matches one in `prev` replaced by that entry.
 *
 * Order and membership always follow `next`; only the identity is borrowed, so
 * a row that moved keeps its place in the new list and its state with it.
 */
export function holdRows<T>(
  next: readonly T[],
  prev: readonly T[] | undefined,
  key: (row: T) => string,
  same: (a: T, b: T) => boolean,
): T[] {
  if (!prev) return [...next];
  const before = new Map<string, T>();
  for (const row of prev) before.set(key(row), row);
  return next.map((row) => {
    const old = before.get(key(row));
    return old !== undefined && same(old, row) ? old : row;
  });
}
