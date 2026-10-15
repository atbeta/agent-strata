/**
 * Session ids the reader pinned to the top of the sidebar.
 *
 * A pin is window-side state, not server state: it says "this window cares
 * about this session", which is a property of the person looking, not of the
 * session itself. That is why it lives in storage here rather than on the
 * backend, and why a pin on a session another window never opens stays
 * invisible to it.
 */
export const PINS_KEY = "strata.pins.v1";

export function readPins(storage: Pick<Storage, "getItem"> = localStorage): string[] {
  try {
    const raw = storage.getItem(PINS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((x): x is string => typeof x === "string" && x.length > 0))];
  } catch {
    return [];
  }
}

export function writePins(ids: string[], storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(PINS_KEY, JSON.stringify(ids));
  } catch {
    // Private mode can refuse storage; pins simply do not persist.
  }
}

/** Most recently pinned first; unpinning keeps the rest of the order. */
export function togglePin(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [id, ...ids];
}
