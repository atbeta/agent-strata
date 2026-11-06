import { describe, expect, test } from "bun:test";
import { approach, isSmoothingCandidate, nextTarget, SMOOTH_EPSILON_PX } from "./smooth-wheel";

describe("isSmoothingCandidate", () => {
  const wheel = (over: Partial<WheelEvent> = {}) => ({
    deltaX: 0,
    deltaY: 120,
    deltaMode: 0,
    ctrlKey: false,
    shiftKey: false,
    ...over,
  });

  test("a mouse notch is a candidate", () => {
    expect(isSmoothingCandidate(wheel())).toBe(true);
  });

  test("small continuous deltas read as trackpad and pass through", () => {
    expect(isSmoothingCandidate(wheel({ deltaY: 8 }))).toBe(false);
    expect(isSmoothingCandidate(wheel({ deltaY: -12.5 }))).toBe(false);
  });

  test("the chunk threshold itself is inclusive", () => {
    expect(isSmoothingCandidate(wheel({ deltaY: 32 }))).toBe(true);
  });

  test("horizontal intent, pinch and shift-wheel are not eased", () => {
    expect(isSmoothingCandidate(wheel({ deltaX: 80, deltaY: 20 }))).toBe(false);
    expect(isSmoothingCandidate(wheel({ ctrlKey: true }))).toBe(false);
    expect(isSmoothingCandidate(wheel({ shiftKey: true }))).toBe(false);
  });

  test("line and page modes scale natively", () => {
    expect(isSmoothingCandidate(wheel({ deltaMode: 1 }))).toBe(false);
    expect(isSmoothingCandidate(wheel({ deltaMode: 2 }))).toBe(false);
  });
});

describe("nextTarget", () => {
  test("an idle gesture starts from where the scroller is", () => {
    expect(nextTarget(500, null, -120, 4000)).toBe(380);
  });

  test("a notch during an approach adds to the pending target", () => {
    expect(nextTarget(480, 300, -120, 4000)).toBe(180);
  });

  test("the target clamps to the scrollable range", () => {
    expect(nextTarget(3950, null, 120, 4000)).toBe(4000);
    expect(nextTarget(5, null, -120, 4000)).toBe(0);
  });
});

describe("approach", () => {
  test("walks toward the target and terminates on it", () => {
    let at = 1000;
    for (let i = 0; i < 200 && at !== 400; i++) at = approach(at, 400, 16);
    expect(at).toBe(400);
  });

  test("never overshoots, from either side", () => {
    let up = 1000;
    let down = 200;
    for (let i = 0; i < 100; i++) {
      const u = approach(up, 400, 16);
      const d = approach(down, 400, 16);
      expect(u).toBeLessThanOrEqual(1000);
      expect(u).toBeGreaterThanOrEqual(400);
      expect(d).toBeGreaterThanOrEqual(200);
      expect(d).toBeLessThanOrEqual(400);
      up = u;
      down = d;
    }
  });

  test("is frame-rate independent: two half steps equal one whole step", () => {
    const whole = approach(1000, 400, 32);
    const half = approach(approach(1000, 400, 16), 400, 16);
    expect(Math.abs(whole - half)).toBeLessThan(0.01);
  });

  test("the last epsilon snaps instead of asymptoting", () => {
    expect(approach(400.4, 400, 16)).toBe(400);
    expect(approach(399.6, 400, 16)).toBe(400);
    expect(approach(400 + SMOOTH_EPSILON_PX, 400, 16)).toBe(400);
    expect(approach(400 + SMOOTH_EPSILON_PX * 2, 400, 16)).toBeGreaterThan(400);
  });
});
