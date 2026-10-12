export const FILES_PANEL_KEY = "strata.files-panel";
export const RAIL_DISMISSED_KEY = "strata.rail-dismissed";

/**
 * Whether the file browser is open.
 *
 * The right side belongs to the window, not to the session. `keyed` routing
 * rebuilds the session view on every tab click, so a signal inside it fell back
 * to its default each time — one reader opened the browser on a session, closed
 * it, and found it open again on the next one. No stored value means closed.
 */
export function readFilesPanel(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return storage.getItem(FILES_PANEL_KEY) === "open";
  } catch {
    // Private mode can refuse storage; a closed panel is still an answer.
    return false;
  }
}

export function writeFilesPanel(open: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(FILES_PANEL_KEY, open ? "open" : "closed");
  } catch {
    // A window that cannot remember the choice still honours it for now.
  }
}

/**
 * Whether the reader closed the right side for good.
 *
 * The browser and the rail share one column, so closing the browser used to
 * reveal the rail rather than an empty edge — and the rail shows itself on any
 * session that touched a file, which made "closed" a state you could not reach.
 * Opening either panel clears this; it is remembered until then.
 */
export function readRailDismissed(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return storage.getItem(RAIL_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeRailDismissed(dismissed: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(RAIL_DISMISSED_KEY, dismissed ? "1" : "0");
  } catch {
    // Same as above: the pane still closes, it just cannot outlive the window.
  }
}
