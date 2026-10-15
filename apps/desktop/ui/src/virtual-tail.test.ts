import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atTail, JUMP_GAP, scrollTopForRow, scrollTopToCentreRow, TAIL_TOLERANCE } from "./virtual-tail";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/**
 * `atTail` decides whether the transcript keeps following the bottom of a
 * session. Getting it wrong is silent and total: the list stops following, a
 * session opens on its first turn, and the message a reader just sent goes on
 * below the fold. These hold the cases that broke it.
 */

describe("at tail", () => {
  test("a list shorter than its scroller is at the tail", () => {
    // The case that broke the transcript. `scrollTop` is 0 because there is
    // nothing to scroll, `extent` is 831 and the window is 950 — the reader is
    // looking at the end of everything. An absolute difference reads 119px of
    // "away from the end" and stops the list following before it ever starts.
    expect(atTail(0, 950, 831)).toBe(true);
  });

  test("the same list in a window shorter than itself is at the tail when scrolled down", () => {
    expect(atTail(831 - 335, 335, 831)).toBe(true);
  });

  test("overscroll past the end is still at the tail", () => {
    // Rubber-banding, a focus scroll, a programmatic clamp past the extent.
    // `Math.abs` called all three of these "away from the end".
    expect(atTail(900, 335, 831)).toBe(true);
  });

  test("a reader who scrolled up is not at the tail", () => {
    expect(atTail(0, 335, 831)).toBe(false);
    expect(atTail(200, 335, 831)).toBe(false);
  });

  test("the tolerance absorbs a row's last pixel of measurement", () => {
    const extent = 3000;
    const viewport = 335;
    const pinned = extent - viewport;
    expect(atTail(pinned - (TAIL_TOLERANCE - 1), viewport, extent)).toBe(true);
    expect(atTail(pinned - (TAIL_TOLERANCE + 1), viewport, extent)).toBe(false);
  });

  test("an empty list does not throw", () => {
    // Nothing to follow, nothing to pin to. The effect guards this too, but a
    // predicate that has to be guarded is a predicate that was not asked.
    expect(atTail(0, 0, 0)).toBe(true);
  });
});

/**
 * A jump is the one scroll the reader asked for by hand, so where it lands is
 * the whole of it. Landing flush against the top edge is what these hold: it
 * reads as a mistake because nothing marks where the jump ended.
 */
describe("jump landing", () => {
  test("a row lands with air above it, not against the edge", () => {
    // Measured before this existed: the row's top came out at exactly 0 against
    // the scroller's box, because `origin()` folds the container's `py-4` into
    // the target and the padding ends up behind the viewport.
    expect(scrollTopForRow(1000)).toBe(1000 - JUMP_GAP);
  });

  test("the first row still lands rather than scrolling negative", () => {
    // Row 0's top is the container padding, which is smaller than the gap.
    // Without the floor this asks for a negative scroll and the browser clamps
    // it anyway, so the row sits at 0 instead of at the gap.
    expect(scrollTopForRow(0)).toBe(0);
    expect(scrollTopForRow(JUMP_GAP - 1)).toBe(0);
    expect(scrollTopForRow(JUMP_GAP)).toBe(0);
  });

  test("centring uses the measured height, not the estimate", () => {
    // The bug this replaces: `clientHeight - estimate` with a 100px estimate
    // against a row that renders at 1034px put the reader 467px off, landing
    // mid-row with a third of it off-screen.
    const top = 4000;
    const viewport = 800;
    const rowHeight = 1034;
    const withMeasurement = scrollTopToCentreRow(top, rowHeight, viewport, 20000);
    // A row taller than the viewport cannot be centred, so it goes to its top.
    expect(withMeasurement).toBe(top);
    expect(scrollTopToCentreRow(top, 200, viewport, 20000)).toBe(top - (viewport - 200) / 2);
  });

  test("a row near the end centres as far up as the scroller can reach", () => {
    // Centring the last turn exactly would need scrollTop past the extent, and
    // the browser silently clamps it — which lands the reader short of centre
    // by however much was unreachable, and looks like the jump did nothing.
    const extent = 2000;
    const viewport = 800;
    const top = 1900;
    const want = scrollTopToCentreRow(top, 200, viewport, extent);
    expect(want).toBe(extent - viewport);
    expect(want + viewport).toBeLessThanOrEqual(extent);
  });

  test("the scroller's own extent is respected when centring past the top", () => {
    expect(scrollTopToCentreRow(100, 1000, 800, 5000)).toBe(100);
    expect(scrollTopToCentreRow(0, 1000, 800, 0)).toBe(0);
  });
});

/**
 * Both of these were invisible in a screenshot and obvious in the DOM: a jump
 * that landed flush against the top edge, and a window that never learned about
 * the scroll it had just been asked for. Neither leaves a mark a test could have
 * caught by looking, so they are held here as source.
 */
describe("jump landing ratchet", () => {
  test("a programmatic scroll rebuilds the window that renders it", () => {
    // Without this the reader jumps and lands somewhere else: the row that was
    // jumped to is not in the document, because the window is computed from the
    // parent's mirror of the scroll, which arrives a frame later through
    // `onScroll`. Measured before: the target was never mounted, at any point in
    // the twelve frames after the click.
    const src = read("virtual.tsx");
    expect(src).toContain("setPendingTop(el.scrollTop)");
  });

  test("the reader's own scroll hands the truth back to the parent", () => {
    // `pendingTop` is an override, not a takeover: leaving it set would mean the
    // window keeps rendering a position the reader has already left.
    const src = read("virtual.tsx");
    const onScroll = src.slice(src.indexOf("const onScroll"));
    expect(onScroll.slice(0, 400)).toContain("setPendingTop(undefined)");
  });

  test("a jump re-anchors on the gap rather than on the edge", () => {
    // The settle loop used to hold drift against 0, which is where the row used
    // to land — so the two halves disagreed and the reader watched the row walk
    // back up to the edge over a few frames.
    const src = read("session-detail.tsx");
    expect(src).toContain("- JUMP_GAP");
  });

  test("the settle loop waits for a row that has not mounted yet", () => {
    // It gave up on the first missing row, spending none of its tries. A jump to
    // a row that is still being measured therefore did nothing at all.
    const src = read("session-detail.tsx");
    expect(src).toContain("if (++waiting > 60) return;");
  });
});

/**
 * The dock is `shrink-0`, so it takes whatever it needs and the transcript gets
 * what is left. Measured against a session carrying one pending question: the
 * dock took 548px of a 900px window and left the conversation 232px of it.
 */
describe("dock ratchet", () => {
  test("the transcript keeps a floor the dock cannot take", () => {
    const src = read("session-detail.tsx");
    expect(src).toContain("min-h-[30vh]");
  });

  test("the pending stack scrolls rather than growing without bound", () => {
    const src = read("session-detail.tsx");
    expect(src).toMatch(/max-h-\[\d+vh\] overflow-y-auto/);
  });
});
