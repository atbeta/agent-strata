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
 * Clicking from one pane to another showed the wrong conversation first: the
 * pane you clicked flashed the transcript of the pane you left, then corrected
 * itself a frame later.
 *
 * Two separate faults, one per clock.
 *
 * **The workspace.** `handleFocusPane` moves focus synchronously and navigates
 * afterwards, because the route is a `location.hash` and lands a frame later.
 * The effect that puts the route session into the focused pane read the pane
 * signal — `updatePaneWorkspace` reads it to get the state it is updating — so
 * it was subscribed to the whole workspace rather than to the route id. It
 * re-fired on the focus change, stamping the session it still held, which was
 * the *previous* route, into the pane that had just been clicked. Rule 4 of
 * `assignSessionToWorkspace` replaced that pane's session in place, so for a
 * frame it showed the other conversation, until the hashchange restored it.
 *
 * **The renderer.** Even with the pane's own session intact, focus arrives a
 * frame before the route does. A pane that swapped renderer on focus alone
 * would ask for the focused transcript during that gap — and that transcript is
 * bound to the route, so it would be the previous session's.
 */
describe("switching panes never paints another pane's conversation", () => {
  test("the route session is assigned on route changes only, not on focus changes", () => {
    const detail = code("session-detail.tsx");
    expect(detail).toContain("on(() => props.id,");
    // A bare effect here is the bug: updatePaneWorkspace reads paneWorkspace()
    // inside the updater, so it would re-fire on every focus change.
    expect(detail).not.toContain(
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
    // conversation each pane holds — so the flash is not the focus.
    const clicked = focusPane(ws, "pane-2");
    expect(clicked.focusedPaneId).toBe("pane-2");
    expect(listLeaves(clicked.root).map((l) => l.sessionId)).toEqual(["s1", "s2"]);

    // It is the assign that follows, carrying the route the pane still holds.
    // Rule 4 replaces the newly focused pane in place, so pane-2 now shows s1 —
    // the conversation of the pane that was left. This is the flash, exactly.
    const flashed = assignSessionToWorkspace(clicked, "s1");
    expect(listLeaves(flashed.root).map((l) => l.sessionId)).toEqual(["s1", "s1"]);

    // With the effect gated on the route, that assign never runs for a focus
    // change, so pane-2 keeps what it was already showing.
    expect(listLeaves(clicked.root).map((l) => l.sessionId)).toEqual(["s1", "s2"]);
  });

  test("the focused transcript waits for the session it is bound to", () => {
    const stage = code("pane-stage.tsx");
    expect(stage).toContain("when={isFocused() && sid() === props.transcriptSessionId}");
    // Focus on its own is the condition that let the stale frame through.
    expect(stage).not.toContain("when={isFocused()}");
    expect(code("session-detail.tsx")).toContain("transcriptSessionId={props.id}");
  });

  test("an unfocused pane still reads as a peer, so nothing else changed", () => {
    expect(code("pane-stage.tsx")).toContain(
      "fallback={props.renderPeerTranscript(sid(), leaf.id)}",
    );
  });
});
