export const BOARD_KEY = "strata.board";

/** Sessions open beside each other. The address bar names the focused one. */
export function readBoard(storage: Pick<Storage, "getItem"> = localStorage): string[] {
  try {
    const raw = storage.getItem(BOARD_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item === "string" && item && !out.includes(item)) out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

export function writeBoard(ids: readonly string[], storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(BOARD_KEY, JSON.stringify(ids));
  } catch {
    // Private mode can refuse storage; the row still works until reload.
  }
}

/** Same array when the id is already open, so a focus change does not rebuild the row. */
export function admit(ids: readonly string[], id: string): string[] {
  if (!id || ids.includes(id)) return ids as string[];
  return [...ids, id];
}

/**
 * Take a session off the row. Closing the focused one moves focus to the
 * neighbour that was on its right, then the one on its left.
 */
export function dismiss(
  ids: readonly string[],
  id: string,
  active: string,
): { ids: string[]; active: string | null } {
  const at = ids.indexOf(id);
  if (at < 0) return { ids: ids as string[], active };
  const next = ids.filter((item) => item !== id);
  if (next.length === 0) return { ids: [], active: null };
  if (active !== id) return { ids: next, active };
  return { ids: next, active: ids[at + 1] ?? ids[at - 1] ?? next[0]! };
}
