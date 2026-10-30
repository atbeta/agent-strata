import { describe, expect, test } from "bun:test";
import { fitScale, zoomAt, zoomBounds } from "./image-zoom";

describe("the enlarged image", () => {
  test("a small picture opens at 1:1 and a large one shrinks into the frame", () => {
    expect(fitScale(400, 300, 1000, 800)).toBe(1);
    expect(fitScale(2000, 1000, 1000, 800)).toBeCloseTo(0.47);
    // A zero dimension anywhere is not a picture yet.
    expect(fitScale(0, 300, 1000, 800)).toBe(1);
    expect(fitScale(400, 300, 0, 0)).toBe(1);
  });

  test("zoom keeps the point under the cursor fixed", () => {
    const pos = { x: 10, y: 20 };
    const anchor = { x: 100, y: 100 };
    const next = zoomAt(1, 2, pos, anchor);
    // The picture point under the anchor was 90px left of the image origin;
    // at 2x it is 180px left, so the origin moves 90px the other way.
    expect(next.x).toBeCloseTo(-80);
    expect(next.y).toBeCloseTo(-60);
    // Round trip returns the picture to where it was.
    const back = zoomAt(2, 1, next, anchor);
    expect(back.x).toBeCloseTo(pos.x);
    expect(back.y).toBeCloseTo(pos.y);
  });

  test("zoom bounds leave room under fit and cap far past real pixels", () => {
    expect(zoomBounds(1).min).toBe(0.5);
    expect(zoomBounds(1).max).toBe(16);
    // A picture that only fits at 2% can still be read at half that.
    expect(zoomBounds(0.02).min).toBe(0.05);
  });
});
