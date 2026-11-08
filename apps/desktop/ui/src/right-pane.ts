/** Which side of the right edge is persisted for the side panel. */
export const SIDE_PANEL_KEY = "strata.side-panel";
export const SIDE_PANEL_TAB_KEY = "strata.side-panel-tab";

/**
 * A tab in the right panel.
 *
 * The builtin set is fixed; anything else is a plugin panel, named
 * `plugin:<plugin-id>`. A string rather than a union so a panel a plugin
 * contributes does not have to be known to this module — the registry is what
 * says whether the name still resolves, and `readPanelTab` keeps a saved tab
 * only if this build still offers it.
 */
export type SidePanelTab = string;

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
    // A plugin tab is kept as written: the rail decides whether the plugin is
    // still running, because this module is loaded before the registry is.
    if (saved === "files" || saved === "background") return saved;
    if (saved && saved.startsWith("plugin:")) return saved;
    return "changes";
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
