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

/**
 * Whether a run of groups is folded all the way.
 *
 * The control that folds every project is also the one that unfolds them, and
 * it asks this first: a reader who folded them one by one has reached the same
 * place as one who used the button, so the button has to agree with the list
 * rather than remember which way it was last pressed. An empty run is not
 * "all folded" — there is nothing to unfold, so the control has nothing to say.
 */
export function everyGroupFolded(keys: readonly string[], folded: ReadonlySet<string>): boolean {
  return keys.length > 0 && keys.every((key) => folded.has(key));
}

/**
 * Fold or unfold exactly these groups, leaving every other fold alone.
 *
 * Lanes and worktrees are folded by the same set, so a control that rebuilt it
 * from scratch would unfold groups the reader folded somewhere else.
 */
export function foldGroups(
  keys: readonly string[],
  folded: ReadonlySet<string>,
  next: boolean,
): Set<string> {
  const out = new Set(folded);
  for (const key of keys) {
    if (next) out.add(key);
    else out.delete(key);
  }
  return out;
}
