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
    const view = require("node:fs").readFileSync(
      require("node:path").join(import.meta.dir, "transcript-view.tsx"),
      "utf8",
    ) as string;
    expect(view).toContain("data-turn-id={turn().turn_id}");
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
    // Command overlays are asked for. They finish with the backdrop fade
    // instead of travelling after it, and they stay shorter than a turn.
    expect(theme).toContain("animation: dialog-pop 0.08s ease-out;");
    const dialog = theme.indexOf("@keyframes dialog-pop");
    expect(theme.slice(dialog, dialog + 180)).toContain("translateY(-3px)");
    // Two pixels. A reader should not be able to catch a block travelling.
    const at = theme.indexOf("@keyframes rise-in");
    expect(theme.slice(at, at + 160)).toContain("translateY(2px)");
  });

  /**
   * The entrance is decided per turn, not held by the element.
   *
   * It was on the assistant message, and a reader switching sessions saw
   * thoughts jump upward; moving it to the turn root did not fix it either. The
   * window mounts rows as it scrolls and rebuilds the whole column on a switch,
   * so whatever node carries the class is replaced by navigation — and a CSS
   * animation belongs to the element, so it starts over. The probe agreed: on a
   * switch, `rise-in` was running on every rendered turn from the first frame.
   *
   * So the class is now a question asked of the ledger rather than a fact about
   * the node: a turn animates the first time it appears in a conversation the
   * reader is already in, and never again.
   */
  test("the entrance is asked of the ledger, not carried by the node", () => {
    const src = transcript();
    const turnRoot = src.slice(
      Math.max(0, src.indexOf("props.turn.reverted ?") - 120),
      src.indexOf("props.turn.reverted ?") + 80,
    );
    // Conditional, so a row that is merely being mounted gets no animation.
    expect(turnRoot).toContain('props.entering?.() ? "rise-in " : ""');
    // And still nothing on the assistant message, which is rebuilt as content
    // streams in and as the window moves.
    const message = src.slice(src.indexOf('data-message-role="assistant"'));
    expect(message.slice(0, 200)).not.toContain("rise-in");
  });

  test("every host of a turn asks the ledger which turns may move in", () => {
    // A split pane is still a reader. Leaving the peer transcript out would put
    // the same shimmer back the moment the column is split.
    for (const file of ["session-detail.tsx", "peer-transcript.tsx"]) {
      const src = require("node:fs").readFileSync(
        require("node:path").join(import.meta.dir, file),
        "utf8",
      ) as string;
      expect(src).toContain("createEntranceLedger()");
      expect(src).toContain("entrance.arriving(");
      expect(src).toContain("entering={() => shown().arriving.has(turn().turn_id)}");
      // Keyed on the session the data says it is. The route's id changes before
      // the view lands, so keying on it would baseline the conversation being
      // left as the one being opened — the whole column, animating, on switch.
      expect(src).toContain('entrance.arriving(v?.session_id ?? ""');
      expect(src).not.toContain("entrance.arriving(props.");
    }
  });
});
