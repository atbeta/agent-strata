/** Which side of the right edge is persisted for the side panel. */
export const SIDE_PANEL_KEY = "strata.side-panel";
export const SIDE_PANEL_TAB_KEY = "strata.side-panel-tab";

export type SidePanelTab = "changes" | "files" | "background";

export function readPanelOpen(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return storage.getItem(SIDE_PANEL_KEY) === "open";
  } catch {
    return false;
  }
}

export function writePanelOpen(open: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(SIDE_PANEL_KEY, open ? "open" : "closed");
  } catch {
    // Private mode can refuse storage; the default still gives a usable panel.
  }
}

export function readPanelTab(storage: Pick<Storage, "getItem"> = localStorage): SidePanelTab {
  try {
    const saved = storage.getItem(SIDE_PANEL_TAB_KEY);
    // A stored tab this build no longer has must not leave the panel blank.
    return saved === "files" || saved === "background" ? saved : "changes";
  } catch {
    return "changes";
  }
}

export function writePanelTab(tab: SidePanelTab, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(SIDE_PANEL_TAB_KEY, tab);
  } catch {
    // Private mode can refuse storage; the default still gives a usable panel.
  }
}
