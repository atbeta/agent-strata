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
const paneScrollMemory = new Map<string, { scrollTop: number; pinned: boolean }>();

/**
 * Where a reader left a session, and how to get them back to it.
 *
 * The key is the pane *and* the session, because both decide what the reader
 * was looking at: the same conversation in two panes is two pieces of reading,
 * and one conversation read in two places in turn is two as well. Keyed on the
 * session alone the two panes overwrite each other; keyed on the pane alone,
 * switching a pane to another conversation loses the place in the one it left.
 *
 * The two transcripts were each spelling this key out themselves, and they did
 * not spell it the same way — the peer transcript used the pane it was handed
 * and the focused one read the pane out of a signal, which is a different pane
 * by the time it is written. That is why a position remembered by one pane came
 * back as another's, and why the fix has to live here rather than at either
 * call site.
 */
function scrollKey(paneId: string, sessionId: string): string {
  return `${paneId}:${sessionId}`;
}

export function rememberPaneScroll(
  paneId: string,
  sessionId: string,
  value: { scrollTop: number; pinned: boolean },
): void {
  paneScrollMemory.set(scrollKey(paneId, sessionId), value);
}

export function recallPaneScroll(
  paneId: string,
  sessionId: string,
): { scrollTop: number; pinned: boolean } | undefined {
  return paneScrollMemory.get(scrollKey(paneId, sessionId));
}

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
  paneScrollMemory,
  contentW,
  setContentWidth,
};
