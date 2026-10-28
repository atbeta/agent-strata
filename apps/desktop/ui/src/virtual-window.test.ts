import { describe, expect, test } from "bun:test";
import { MAX_MOUNTED_ROWS, mountedRange } from "./virtual-window";

/**
 * A prefix-sum stand-in: rows of a fixed height, so `rowAt` is arithmetic.
 * Real rows are not uniform, but the window maths only ever asks "which row
 * contains this pixel", and a uniform list answers that exactly.
 */
const uniform = (rowHeight: number, count: number) => (y: number) =>
  Math.min(count, Math.max(0, Math.floor(y / rowHeight)));

describe("the rows a transcript mounts", () => {
  test("a pixel budget with a small estimate mounts too many", () => {
    // The bug: 100px estimate against 352px rows, 800 overscan either side and
    // an 800px viewport. The pixel budget buys 18 rows for a viewport that
    // shows 2. Every one of them parses markdown on mount.
    const rowAt = uniform(132, 200);
    const { first, last } = mountedRange({
      count: 200,
      top: 5000,
      viewport: 800,
      overscan: 800,
      rowAt,
    });
    expect(last - first + 1).toBeLessThanOrEqual(MAX_MOUNTED_ROWS);
  });

  test("the viewport is always covered, whatever the cap says", () => {
    // A cap that cut into the viewport would leave the pane blank below the
    // fold. Rows here are small, so the viewport alone is more rows than the
    // cap allows — the viewport still wins.
    const rowAt = uniform(40, 500);
    const { first, last } = mountedRange({
      count: 500,
      top: 2000,
      viewport: 1200,
      overscan: 100,
      maxRows: 4,
      rowAt,
    });
    // 1200 / 40 = 30 rows visible; the window must contain all of them.
    expect(last - first + 1).toBeGreaterThanOrEqual(30);
  });

  test("a short list mounts in full", () => {
    const rowAt = uniform(300, 3);
    const { first, last } = mountedRange({ count: 3, top: 0, viewport: 800, overscan: 800, rowAt });
    expect(first).toBe(0);
    expect(last).toBe(2);
  });

  test("an empty list has no rows to mount", () => {
    expect(mountedRange({ count: 0, top: 0, viewport: 800, overscan: 800, rowAt: () => 0 })).toEqual({
      first: 0,
      last: -1,
    });
  });

  test("a scroll position past the end still mounts the last row", () => {
    // A position carried over from another session is past this one's end.
    // `rowAt` answers `count` there, and a window starting past the end renders
    // nothing — the empty pane this list must never draw.
    const rowAt = uniform(300, 10);
    const { first, last } = mountedRange({
      count: 10,
      top: 999_999,
      viewport: 800,
      overscan: 800,
      rowAt,
    });
    expect(first).toBeLessThanOrEqual(last);
    expect(last).toBe(9);
    expect(first).toBe(9);
  });

  test("the range never goes backwards", () => {
    const rowAt = uniform(120, 100);
    for (const top of [0, 500, 5000, 11_000, 50_000]) {
      const { first, last } = mountedRange({ count: 100, top, viewport: 700, overscan: 400, rowAt });
      expect(first).toBeGreaterThanOrEqual(0);
      expect(last).toBeGreaterThanOrEqual(first);
      expect(last).toBeLessThan(100);
    }
  });

  test("a cap of one still mounts something", () => {
    const rowAt = uniform(50, 50);
    const { first, last } = mountedRange({
      count: 50,
      top: 0,
      viewport: 0,
      overscan: 0,
      maxRows: 1,
      rowAt,
    });
    expect(last).toBeGreaterThanOrEqual(first);
  });

  test("the default cap is what an unconfigured list gets", () => {
    expect(MAX_MOUNTED_ROWS).toBeGreaterThan(0);
    const rowAt = uniform(100, 400);
    const withDefault = mountedRange({ count: 400, top: 10_000, viewport: 800, overscan: 1200, rowAt });
    const withExplicit = mountedRange({
      count: 400,
      top: 10_000,
      viewport: 800,
      overscan: 1200,
      maxRows: MAX_MOUNTED_ROWS,
      rowAt,
    });
    expect(withDefault).toEqual(withExplicit);
  });
});
