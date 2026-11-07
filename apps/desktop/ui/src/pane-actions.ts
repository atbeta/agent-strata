import { createEffect, on } from "solid-js";
import {
  applyLayoutPreset,
  assignSessionToWorkspace,
  closePane,
  focusedLeaf,
  focusPane,
  resizeSplit,
  setPaneSession,
  splitPane,
  toggleZoomPane,
  type LayoutPreset,
  type PaneWorkspaceState,
  type SplitDir,
} from "./pane-tree";
import { paneWorkspace, updatePaneWorkspace } from "./session-chrome";
import type { SessionRowSummary } from "./pane-stage";

/** The pane workspace's actions for the session the route has open. */
export function usePaneActions(props: { id: string; sessions: SessionRowSummary[] }) {
  // The route session belongs in the focused pane — but only when the route
  // session *changes*.
  //
  // `updatePaneWorkspace` reads the pane signal to get the state it is updating,
  // so a plain effect reading it becomes subscribed to the whole workspace. It
  // then re-ran on every focus change, not just on the route, and stamped the
  // session it was holding — which, on the frame you clicked another pane, was
  // still the *previous* route. `assignSessionToWorkspace` answered rule 4 and
  // replaced the focused pane's session in place, so the pane you had just
  // clicked adopted the other conversation for a frame, and swapped back when
  // the hashchange finally landed. `on` narrows the subscription to the one
  // value this effect is actually about.
  createEffect(
    on(() => props.id, (id) => {
      updatePaneWorkspace((ws) => assignSessionToWorkspace(ws, id));
    }),
  );

  const candidateSessionIds = () => props.sessions.map((s) => s.summary.session_id);

  const navigatePaneSession = (sessionId: string | null) => {
    if (sessionId && sessionId !== props.id) {
      location.hash = `/session/${encodeURIComponent(sessionId)}`;
    }
  };

  const selectPreset = (preset: LayoutPreset) => {
    const next = updatePaneWorkspace((ws) =>
      applyLayoutPreset(ws, preset, props.id, candidateSessionIds()),
    );
    navigatePaneSession(focusedLeaf(next).sessionId);
  };

  const split = (paneId: string, dir: SplitDir) => {
    // Seed the new split with the next session not already on screen, or leave
    // the pane empty for the picker.
    const usedIds = new Set<string>();
    const collectUsed = (n: PaneWorkspaceState["root"]) => {
      if (n.kind === "leaf") {
        if (n.sessionId) usedIds.add(n.sessionId);
      } else {
        collectUsed(n.a);
        collectUsed(n.b);
      }
    };
    collectUsed(paneWorkspace().root);
    usedIds.add(props.id);
    const nextCandidate = candidateSessionIds().find((sid) => !usedIds.has(sid)) ?? null;
    const next = updatePaneWorkspace((ws) => splitPane(ws, paneId, dir, nextCandidate));
    navigatePaneSession(focusedLeaf(next).sessionId);
  };

  const focus = (paneId: string, sessionId: string | null) => {
    updatePaneWorkspace((ws) => focusPane(ws, paneId));
    navigatePaneSession(sessionId);
  };

  const selectSession = (paneId: string, sessionId: string) => {
    updatePaneWorkspace((ws) => setPaneSession(ws, paneId, sessionId));
    navigatePaneSession(sessionId);
  };

  const close = (paneId: string) => {
    const next = updatePaneWorkspace((ws) => closePane(ws, paneId));
    navigatePaneSession(focusedLeaf(next).sessionId);
  };

  const toggleZoom = (paneId: string) => {
    const next = updatePaneWorkspace((ws) => toggleZoomPane(ws, paneId));
    navigatePaneSession(focusedLeaf(next).sessionId);
  };

  const resize = (splitId: string, ratio: number) => {
    updatePaneWorkspace((ws) => resizeSplit(ws, splitId, ratio));
  };

  return { selectPreset, split, focus, selectSession, close, toggleZoom, resize };
}
