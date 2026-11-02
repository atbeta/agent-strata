import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROW_ESTIMATE, ROW_GAP } from "./transcript-layout";
import { aheadOrder, mountedRange } from "./virtual-window";

/**
 * A prefix-sum stand-in: rows of a fixed height, so `rowAt` is arithmetic.
 * Real rows are not uniform, but the window maths only ever asks "which row
 * contains this pixel", and a uniform list answers that exactly.
 */
const uniform = (rowHeight: number, count: number) => (y: number) =>
  Math.min(count, Math.max(0, Math.floor(y / rowHeight)));

describe("the rows a transcript mounts", () => {
  test("the estimate is near a real turn, so one screen mounts a handful", () => {
    // 100px against ~350px turns made the pixel budget mount about three
    // times the rows on screen, and every one of them parsed markdown in
    // that frame. A row cap then threw the extras away, so the next scroll
    // mounted and parsed them again. The estimate is what keeps the count
    // down; the window itself stays the pixels the reader can reach.
    const stride = ROW_ESTIMATE + ROW_GAP;
    const rowAt = uniform(stride, 400);
    const { first, last } = mountedRange({
      count: 400,
      top: 50_000,
      viewport: 800,
      overscan: 800,
      rowAt,
    });
    expect(last - first + 1).toBeLessThanOrEqual(10);
    expect(last - first + 1).toBeGreaterThan(0);
  });

  test("overscan stays mounted instead of being trimmed to a row cap", () => {
    // Capping the count unmounted rows the reader was about to scroll into,
    // and mounting them again was the hitch. The pixel budget is the window.
    const rowAt = uniform(40, 500);
    const top = 2000;
    const viewport = 200;
    const overscan = 400;
    const { first, last } = mountedRange({ count: 500, top, viewport, overscan, rowAt });
    expect(first).toBeLessThanOrEqual(Math.floor((top - overscan) / 40));
    expect(last).toBeGreaterThanOrEqual(Math.min(499, Math.floor((top + viewport + overscan) / 40)));
  });

  test("the viewport is inside the window", () => {
    const rowAt = uniform(40, 500);
    const top = 2000;
    const viewport = 1200;
    const { first, last } = mountedRange({ count: 500, top, viewport, overscan: 100, rowAt });
    expect(first).toBeLessThanOrEqual(Math.floor(top / 40));
    expect(last).toBeGreaterThanOrEqual(Math.floor((top + viewport) / 40));
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
});

describe("which rows ahead of the view are warmed first", () => {
  test("nearest the view first, alternating above and below", () => {
    expect(aheadOrder({ first: 5, last: 6 }, { first: 2, last: 9 })).toEqual([4, 7, 3, 8, 2, 9]);
  });

  test("an edge of the list leaves one side to run on", () => {
    expect(aheadOrder({ first: 0, last: 1 }, { first: 0, last: 4 })).toEqual([2, 3, 4]);
  });

  test("nothing ahead is nothing to warm", () => {
    expect(aheadOrder({ first: 3, last: 5 }, { first: 3, last: 5 })).toEqual([]);
  });
});

describe("rows follow their segment, not their slot", () => {
  test("the window is a list of row ids, and the row reads its place from the layout", () => {
    const virtual = readFileSync(join(import.meta.dir, "virtual.tsx"), "utf8");
    expect(virtual).toContain("<For each={windowIds()}>");
    expect(virtual).toContain("props.layout.indexOf(id)");
    // A row keyed by id renders one item for life, so nothing has to rebind it.
    expect(virtual).not.toContain("entry.key = key");
    expect(virtual).not.toContain("stableIndexWindow");
  });
});

describe("rows ahead of the view mount once they are warm", () => {
  test("what is on screen mounts at once, and what is ahead once warmed", () => {
    const virtual = readFileSync(join(import.meta.dir, "virtual.tsx"), "utf8");
    expect(virtual).toContain("visible: at(0)");
    expect(virtual).toContain("if (!props.warm || warmed.has(id)) ids.push(id);");
    expect(virtual).toContain("aheadOrder(r.visible, r.ahead)");
    // A row that was mounted on screen is already parsed; dropping it the
    // moment it scrolls off screen would unmount and warm it all over again.
    expect(virtual).toContain("if (i >= r.visible.first && i <= r.visible.last) warmed.add(id);");
    const view = readFileSync(join(import.meta.dir, "transcript-view.tsx"), "utf8");
    expect(view).toContain("warm={warmSegment}");
  });
});

describe("a mounted row is complete", () => {
  test("nothing inside a row waits for a later frame to draw", () => {
    // A row that mounts half-empty and fills in later measures as the empty
    // box, and the scroll owner has to tell that apart from a real height.
    // Waiting belongs to the window, which does not mount the row until it
    // can be drawn whole.
    for (const file of ["md.tsx", "payload.tsx", "transcript.tsx", "virtual.tsx"]) {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      expect(src).not.toContain("paint-mode");
      expect(src).not.toContain("useRowPaintMode");
    }
    for (const file of ["md.tsx", "payload.tsx", "transcript.tsx"]) {
      expect(readFileSync(join(import.meta.dir, file), "utf8")).not.toContain("paint-queue");
    }
  });
});
