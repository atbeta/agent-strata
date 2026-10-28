import { createSignal } from "solid-js";
import {
  clampContentWidth,
  readContentWidth,
  writeContentWidth,
} from "./content-width";
import {
  readPanelOpen,
  readPanelTab,
  writePanelOpen,
  writePanelTab,
  type SidePanelTab,
} from "./right-pane";
import {
  readPaneWorkspace,
  splitPane,
  writePaneWorkspace,
  type PaneWorkspaceState,
  type SplitDir,
} from "./pane-tree";

/**
 * The right side belongs to the window, not to the tab.
 *
 * Both signals used to live inside `SessionDetail`, which `App` renders `keyed`
 * on the session id — every tab click tore them down and built fresh ones.
 * They are the reader's, so they outlive the session.
 */
const [panelOpen, setPanelOpen] = createSignal(readPanelOpen());
const [panelTab, setPanelTab] = createSignal<SidePanelTab>(readPanelTab());
const [paneWorkspace, setPaneWorkspace] = createSignal<PaneWorkspaceState>(readPaneWorkspace());
/**
 * The reading column's width, shared by every transcript and the composer so
 * they always end on the same edges. Module scope like the pane workspace:
 * the width belongs to the window, not to whichever pane is focused.
 */
const [contentW, setContentW] = createSignal(readContentWidth());
const setContentWidth = (px: number, remember = true) => {
  const next = clampContentWidth(px);
  setContentW(next);
  if (remember) writeContentWidth(next);
};

export function updatePaneWorkspace(updater: (prev: PaneWorkspaceState) => PaneWorkspaceState): PaneWorkspaceState {
  const cur = paneWorkspace();
  const next = updater(cur);
  if (next === cur) return cur;
  setPaneWorkspace(next);
  writePaneWorkspace(next);
  return next;
}

/**
 * Open `sessionId` in a new split beside the currently focused pane and
 * navigate to it.
 */
export function openSessionInSplit(sessionId: string, dir: SplitDir = "row"): void {
  updatePaneWorkspace((ws) => splitPane(ws, ws.focusedPaneId, dir, sessionId));
  location.hash = `/session/${encodeURIComponent(sessionId)}`;
}

export {
  panelOpen,
  setPanelOpen,
  panelTab,
  setPanelTab,
  paneWorkspace,
  contentW,
  setContentWidth,
};
