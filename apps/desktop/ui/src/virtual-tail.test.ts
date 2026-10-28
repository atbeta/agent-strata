import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atTail, TAIL_TOLERANCE } from "./virtual-tail";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/**
 * `atTail` decides whether the transcript keeps following the bottom of a
 * session. Getting it wrong is silent and total: the list stops following, a
 * session opens on its first turn, and the message a reader just sent goes on
 * below the fold. These hold the cases that broke it.
 */

describe("scroll hot paths reuse work already done", () => {
  test("a measurement uses its observed row instead of indexing every turn", () => {
    const src = read("virtual.tsx");
    expect(src).not.toContain("const rowIndex");
    expect(src).toContain("const observation = observed.get(e.target)");
  });
});

describe("a window that cannot be placed still draws something", () => {
  /**
   * The guarantee lives in `mountedRange`, which clamps the start to the last
   * row, so an inverted window cannot be produced in the first place. The
   * behaviour is checked for real in `virtual-window.test.ts`, and this checks
   * that the list still goes through that function rather than computing a
   * window by hand again.
   */
  const rows = read("virtual.tsx").slice(
    read("virtual.tsx").indexOf("const rows = createMemo"),
  );

  test("the window is computed by the range helper, not by hand", () => {
    expect(rows).toContain("mountedRange({");
    // A second, hand-rolled window would be a second place to get this wrong.
    expect(rows).not.toContain("const last = Math.min(n - 1, rowAt(");
  });

  test("the range is taken inside the window memo, where the rows are decided", () => {
    const memoStart = rows.indexOf("const rows = createMemo");
    const call = rows.indexOf("mountedRange({");
    expect(call).toBeGreaterThan(memoStart);
    expect(call).toBeLessThan(rows.indexOf("const out: number[]"));
  });
});

describe("at tail", () => {
  test("a list shorter than its scroller is at the tail", () => {
    // The case that broke the transcript. `scrollTop` is 0 because there is
    // nothing to scroll, `extent` is 831 and the window is 950 — the reader is
    // looking at the end of everything. An absolute difference reads 119px of
    // "away from the end" and stops the list following before it ever starts.
    expect(atTail(0, 950, 831)).toBe(true);
  });

  test("the same list in a window shorter than itself is at the tail when scrolled down", () => {
    expect(atTail(400, 500, 890)).toBe(true);
  });

  test("overscroll past the end is still at the tail", () => {
    expect(atTail(520, 500, 890)).toBe(true);
  });

  test("a reader who scrolled up is not at the tail", () => {
    expect(atTail(100, 500, 890)).toBe(false);
  });

  test("the tolerance absorbs a row's last pixel of measurement", () => {
    // 30px short is inside the tolerance — a row shrinking by less than that
    // cannot pull the reader off the tail.
    expect(atTail(360, 500, 890, 30)).toBe(true);
    expect(atTail(359, 500, 890, 30)).toBe(false);
  });

  test("an empty list does not throw", () => {
    expect(atTail(0, 500, 0)).toBe(true);
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
