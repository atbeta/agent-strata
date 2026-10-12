export const THINKING_KEY = "strata.thinking";

/** Whether a thought starts open. A missing value is collapsed. */
export function readThinkingOpen(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return storage.getItem(THINKING_KEY) === "open";
  } catch {
    return false;
  }
}

export function saveThinkingOpen(open: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(THINKING_KEY, open ? "open" : "closed");
  if (typeof window !== "undefined") window.dispatchEvent(new Event("strata-thinking"));
}
