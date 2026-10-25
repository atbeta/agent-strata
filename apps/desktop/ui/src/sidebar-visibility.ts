/**
 * Whether the left column is on screen.
 *
 * The session list is the way into everything, and on a wide window it can
 * take a third of the screen away from the conversation being read. Folding it
 * away is the reader's call, so the answer is remembered — but only the answer:
 * where the button that undoes it lives differs by platform, and that is the
 * platform's business, not this file's.
 */
export const SIDEBAR_KEY = "strata.sidebar";

export function readSidebarOpen(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    // Open is the default, so anything that is not an explicit "closed" reads
    // as open. A key written by a newer build must not leave the window
    // without a way into the list.
    return storage.getItem(SIDEBAR_KEY) !== "closed";
  } catch {
    // Private mode can refuse storage; the list still shows.
    return true;
  }
}

export function writeSidebarOpen(open: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(SIDEBAR_KEY, open ? "open" : "closed");
  } catch {
    // A window that cannot remember the choice still folds and unfolds.
  }
}
