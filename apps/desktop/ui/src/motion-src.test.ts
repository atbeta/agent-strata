import { describe, expect, test } from "bun:test";

/**
 * TurnBlock renders a streaming turn: it is re-evaluated as tokens arrive, and
 * its rows are an `<Index>` over the message/tool flow rather than a `<For>`.
 *
 * That choice is what makes entrance motion safe here. `<For>` maps by
 * identity — replace every item and it tears every node down and builds a new
 * one — so an entrance animation on a `<For>` row replays on every token and
 * the transcript strobes. `<Index>` maps by position: an item arriving at the
 * end creates one node and leaves the rest alone, so the animation runs once,
 * when a block first appears, which is what a reader can read as motion rather
 * than as a flicker.
 */
describe("the transcript's flow is positioned so motion is possible", () => {
  const transcript = () =>
    require("node:fs").readFileSync(
      require("node:path").join(import.meta.dir, "transcript.tsx"),
      "utf8",
    ) as string;

  test("rows are indexed by position, not by identity", () => {
    const src = transcript();
    const flow = src.slice(src.indexOf("<Index each={flow()}>"));
    expect(flow).toContain("<Index each={flow()}>");
    // A `<For>` anywhere in the flow would rebuild the rows on every token.
    expect(flow.slice(0, 400)).not.toContain("<For each=");
  });

  test("a turn block is keyed by turn id where it is mounted", () => {
    // The window mounts rows by turn id, so a turn that is already on screen is
    // updated in place and a turn that is new gets one entrance.
    const detail = require("node:fs").readFileSync(
      require("node:path").join(import.meta.dir, "session-detail.tsx"),
      "utf8",
    ) as string;
    expect(detail).toContain("data-turn-id={turn().turn_id}");
  });

  test("a tool run is positioned too, so its cards are not rebuilt mid-run", () => {
    // The same argument as the message flow, one component down. A run is built
    // while it works — calls arrive one at a time — and `<For>` maps by
    // identity, so it rebuilt every card each time the array changed. That reset
    // each card's internal state and would have replayed their entrance on every
    // arrival.
    const src = transcript();
    const run = src.slice(src.indexOf("function ToolRun("));
    expect(run.slice(0, 2600)).toContain("<Index each={props.calls}>");
    expect(run.slice(0, 2600)).not.toContain("<For each={props.calls}>");
    // `<Index>` hands over an accessor, and the card takes a value.
    expect(run).toContain("call={call()}");
  });

  test("the reduced-motion rule is a media query on the root, not per call site", () => {
    // One place turns every duration down, so a new animation inherits the
    // behaviour instead of each one having to remember it.
    //
    // It named transitions only. Every entrance in the theme is a keyframe
    // animation, so a reader who had asked their system for less motion was
    // served the menu pop, the dialog pop, the fade and the running grid
    // anyway. Animations are named here for the same reason transitions are:
    // a state drawn only by its animation still has to read, and the running
    // mark is a moving grid, so it is left as a static grid rather than hidden.
    const theme = require("node:fs").readFileSync(
      require("node:path").join(import.meta.dir, "theme.css"),
      "utf8",
    ) as string;
    const at = theme.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(at).toBeGreaterThan(-1);
    // To the closing brace of the rule, not a fixed length: the comment above
    // the declarations is longer than any window worth reading.
    const rule = theme.slice(at, theme.indexOf("\n  }", at));
    expect(rule).toContain("transition-duration: 0.01ms !important");
    expect(rule).toContain("animation-duration: 0.01ms !important");
    expect(rule).toContain("animation-iteration-count: 1 !important");
  });

  test("nothing new loops", () => {
    // The running grid is the one thing in this app allowed to move
    // continuously. A second loop next to it is two things pulsing in the same
    // glance, so every entrance here runs once.
    const theme = require("node:fs").readFileSync(
      require("node:path").join(import.meta.dir, "theme.css"),
      "utf8",
    ) as string;
    for (const name of ["rise-in", "tool-live-in"]) {
      const at = theme.indexOf(`@keyframes ${name}`);
      expect(at).toBeGreaterThan(-1);
      const body = theme.slice(at, theme.indexOf("}", at));
      expect(body).not.toContain("infinite");
    }
    expect(theme).toContain("animation: rise-in 0.16s ease-out both;");
    // Four pixels. A reader should not be able to catch a block travelling.
    const at = theme.indexOf("@keyframes rise-in");
    expect(theme.slice(at, at + 160)).toContain("translateY(4px)");
  });
});
