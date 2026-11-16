import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyLayoutPreset,
  assignSessionToWorkspace,
  createInitialWorkspace,
  focusPane,
  listLeaves,
} from "./pane-tree";
const code = (f: string) =>
  readFileSync(join(import.meta.dir, f), "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");

/**
 * Clicking from one pane to another used to paint the wrong conversation, and
 * then throw the column away and build it again.
 *
 * The route effect assigns a session only when the route changes, so a focus
 * change cannot stamp the previous route onto the pane you just clicked. A
 * session that is already open is focused where it is, rather than copied.
 * The transcript itself stays mounted: focus changes who owns the composer,
 * not which list is on screen.
 */
describe("switching panes never paints another pane's conversation", () => {
  test("the route session is assigned on route changes only, not on focus changes", () => {
    const actions = code("pane-actions.ts");
    expect(actions).toContain("on(() => props.id,");
    // A bare effect here is the bug: updatePaneWorkspace reads paneWorkspace()
    // inside the updater, so it would re-fire on every focus change.
    expect(actions).not.toContain(
      "createEffect(() => {\n    const id = props.id;\n    updatePaneWorkspace",
    );
    // And the reason it over-subscribes is worth pinning, since it is a
    // property of the helper rather than of the call site.
    expect(code("session-chrome.ts")).toContain("const cur = paneWorkspace();");
  });

  test("focus alone moves no session, so the flash could only come from the assign", () => {
    // The real mechanism, on the real functions rather than a model of them.
    // Both slots full, pane-1 focused and the route is s1.
    let ws = applyLayoutPreset(createInitialWorkspace("s1"), "cols-2", "s1");
    ws = assignSessionToWorkspace(ws, "s2"); // fills pane-2
    ws = focusPane(ws, "pane-1");
    expect(listLeaves(ws.root).map((l) => l.sessionId)).toEqual(["s1", "s2"]);

    // Clicking pane-2 moves focus. By itself that changes nothing about which
    // conversation each pane holds.
    const clicked = focusPane(ws, "pane-2");
    expect(clicked.focusedPaneId).toBe("pane-2");
    expect(listLeaves(clicked.root).map((l) => l.sessionId)).toEqual(["s1", "s2"]);

    // The route effect does not run for a focus change. If it did, and it
    // carried the session the route still held, that session is already open
    // in pane-1 — focus goes back there, it is not copied onto pane-2.
    const redirected = assignSessionToWorkspace(clicked, "s1");
    expect(listLeaves(redirected.root).map((l) => l.sessionId)).toEqual(["s1", "s2"]);
    expect(redirected.focusedPaneId).toBe("pane-1");
  });

  test("focus does not swap in a second transcript", () => {
    // The route transcript and the peer transcript were two trees. Focusing a
    // pane disposed one and mounted the other, so the column jumped to the top
    // and a session that had fallen out of the cache loaded from scratch.
    // One transcript is born with the pane and stays with it. Focus only
    // changes who owns the composer.
    const stage = code("pane-stage.tsx");
    expect(stage).not.toContain("renderPeerTranscript");
    expect(stage).not.toContain("transcriptSessionId");
    expect(stage).not.toContain("fallback={renderNode(");
    expect(stage).toContain("<PaneBranch node={props.workspace.root} />");
    expect(stage).toContain("stage.renderTranscript(props.sessionId, props.paneId)");
    // Single mode is still the route's own transcript, with no pane around it.
    expect(stage).toContain("fallback={props.renderFocusedTranscript()}");
  });

  test("a focused session's stream still reaches the pane that is showing it", () => {
    // Partials for the route session used to stay inside SessionDetail, because
    // that was the tree on screen. The pane's own transcript is on screen now,
    // including while it is the focused one, so it has to hear the same events.
    const detail = code("session-detail.tsx");
    expect(detail).not.toContain("evt.session_id !== props.id");
    expect(detail).toContain('new CustomEvent("strata-stream-event"');
  });
});
