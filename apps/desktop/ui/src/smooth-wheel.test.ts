import { describe, expect, test } from "bun:test";
import {
  approach,
  correction,
  frameDelta,
  isSmoothingCandidate,
  nextTarget,
  NOMINAL_FRAME_MS,
  SMOOTH_EPSILON_PX,
  STALL_FRAMES,
  stalled,
} from "./smooth-wheel";

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

describe("stalled", () => {
  test("a scroller that refuses the write is at a standstill", () => {
    // What the runaway looked like: the ease wanted 800546 and the scroller
    // stayed on 800599, so the gap never closed.
    expect(stalled(800599, 800599, 800546)).toBe(true);
  });

  test("a scroller that moved this frame is not stalled", () => {
    expect(stalled(1000, 990, 400)).toBe(false);
  });

  test("a write the scroller rounded away counts as no movement", () => {
    // The first frame after a notch moves half a pixel and the scroller rounds
    // it back onto the integer it came from. One such frame is normal; the loop
    // tolerates STALL_FRAMES of them before giving up.
    expect(stalled(800646, 800646, 800546)).toBe(true);
  });

  test("arriving is not a stall", () => {
    // The caller checks `next === target` first; this only guards the case
    // where it did not arrive and cannot.
    expect(stalled(400, 400, 400)).toBe(false);
    expect(stalled(400.4, 400, 400)).toBe(false);
  });

  test("an ease to a reachable target still runs its frames", () => {
    // The guard must not cut a real ease short.
    let at = 1000;
    let frames = 0;
    for (; frames < 400; frames++) {
      const before = at;
      const next = approach(before, 400, 16);
      at = next;
      if (next === 400 || stalled(before, at, 400)) break;
    }
    expect(at).toBe(400);
    expect(frames).toBeGreaterThan(3);
  });

  test("a real notch lands even though its first frames are rounded away", () => {
    // The measured case: a 100px notch from the tail, with the scroller rounding
    // every write onto the device grid. The ease must still travel the gesture;
    // it settles a couple of pixels short because near the target each frame
    // moves less than the rounding step, which is invisible.
    let at = 800646;
    const target = 800546;
    let idle = 0;
    let frames = 0;
    for (; frames < 400; frames++) {
      const before = at;
      const dt = frameDelta(1000 + frames * 16, 1000 + (frames - 1) * 16);
      const next = approach(before, target, dt);
      at = Math.round(next); // the scroller's own rounding
      if (next === target || at === target) break;
      idle = stalled(before, at, target) ? idle + 1 : 0;
      if (idle >= STALL_FRAMES) break;
    }
    expect(target - at).toBeLessThan(5);
    expect(frames).toBeGreaterThan(5);
  });

  test("a loop that can never land gives up within STALL_FRAMES frames", () => {
    // A scroller held above the target: every write is refused. The loop must
    // notice in a bounded number of frames instead of spinning forever.
    let at = 800599;
    const target = 800546;
    let idle = 0;
    let frames = 0;
    for (; frames < 600; frames++) {
      const before = at;
      const next = approach(before, target, 16);
      at = before; // the write is refused entirely
      if (next === target) break;
      idle = stalled(before, at, target) ? idle + 1 : 0;
      if (idle >= STALL_FRAMES) break;
    }
    expect(frames).toBeLessThanOrEqual(STALL_FRAMES);
    expect(at).toBe(800599);
  });
});

describe("correction", () => {
  test("the position moves by the correction and the notch keeps its distance", () => {
    // The owner wants the scroller 200px further down because a row above grew.
    const c = correction({ at: 1000, delta: 200, target: 700, max: 4000 });
    expect(c.at).toBe(1200);
    // The notch was 300px away and still is.
    expect(c.target).toBe(900);
  });

  test("the notch's target moves by what the position actually moved", () => {
    // The correction was clipped by the range: the target follows what
    // happened, not what was asked for.
    const c = correction({ at: 100, delta: -500, target: 0, max: 4000 });
    expect(c.at).toBe(0);
    expect(c.target).toBe(0);
  });

  test("a correction that would leave the range stops at its edge", () => {
    const c = correction({ at: 3900, delta: 500, target: 3000, max: 4000 });
    expect(c.at).toBe(4000);
    expect(c.target).toBe(3100);
  });

  test("no notch running leaves the target alone", () => {
    expect(correction({ at: 1000, delta: 50, target: null, max: 4000 })).toEqual({ at: 1050, target: null });
  });
});

describe("frameDelta", () => {
  test("the first frame gets a nominal step, not the zero the clocks imply", () => {
    // exp(0) is exactly 1, so a zero dt makes the ease return the position it
    // read: the write lands where it started and the gap can never close. The
    // rAF timestamp is the frame's start, which is not later than the
    // performance.now() the loop was started from.
    expect(frameDelta(1000, 0)).toBe(NOMINAL_FRAME_MS);
  });

  test("a zero or backwards delta after the first frame still advances", () => {
    expect(frameDelta(1000, 1000)).toBe(1);
    expect(frameDelta(900, 1000)).toBe(1);
  });

  test("an ordinary frame passes through", () => {
    expect(frameDelta(1016, 1000)).toBe(16);
    expect(frameDelta(1033, 1016)).toBe(17);
  });

  test("a frozen tab cannot fling the scroll on return", () => {
    expect(frameDelta(1000 + 5_000, 1000)).toBe(64);
  });

  test("a one millisecond frame moves away from the target", () => {
    expect(approach(1000, 400, frameDelta(1000, 1000))).toBeLessThan(1000);
  });
});
