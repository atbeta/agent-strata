import { describe, expect, test } from "bun:test";
import { atTail, TAIL_TOLERANCE } from "./virtual-tail";

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
