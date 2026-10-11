/** Recent root sessions for Ctrl+Tab. The sidebar decides which rows count. */

const MRU_KEY = "strata.session-mru";
const MRU_CAP = 40;

export interface SwitchRow {
  id: string;
  lastTs: number;
}

export interface MruStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readMru(storage: Pick<MruStorage, "getItem"> = localStorage): string[] {
  try {
    const raw = storage.getItem(MRU_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string").slice(0, MRU_CAP);
  } catch {
    return [];
  }
}

export function touchMru(mru: readonly string[], id: string): string[] {
  return [id, ...mru.filter((item) => item !== id)].slice(0, MRU_CAP);
}

export function writeMru(ids: readonly string[], storage: Pick<MruStorage, "setItem"> = localStorage): void {
  try {
    storage.setItem(MRU_KEY, JSON.stringify(ids.slice(0, MRU_CAP)));
  } catch {
    // private mode, or storage disabled
  }
}

/**
 * Most recent first. Visit order wins; sessions never visited follow by last activity.
 * The open session stays at the front, so the first Tab lands on the previous one.
 */
export function recentOrder(rows: readonly SwitchRow[], mru: readonly string[], currentId?: string): string[] {
  const known = new Set(rows.map((row) => row.id));
  const pinned = mru.filter((id, index) => known.has(id) && mru.indexOf(id) === index);
  const rest = [...rows]
    .sort((a, b) => b.lastTs - a.lastTs || a.id.localeCompare(b.id))
    .map((row) => row.id)
    .filter((id) => !pinned.includes(id));
  const ordered = [...pinned, ...rest];
  if (!currentId || ordered[0] === currentId || !known.has(currentId)) return ordered;
  return [currentId, ...ordered.filter((id) => id !== currentId)];
}

/**
 * `at === null` means the gesture is just starting.
 * With the current session at the front, the first step moves off it.
 * Otherwise the first forward step lands on the newest session.
 */
export function stepIndex(input: {
  length: number;
  at: number | null;
  delta: number;
  currentAtFront: boolean;
}): number | null {
  if (input.length < 2 || input.delta === 0) return null;
  const origin = input.at !== null ? input.at : input.currentAtFront ? 0 : input.delta > 0 ? -1 : 0;
  const next = origin + input.delta;
  return ((next % input.length) + input.length) % input.length;
}
