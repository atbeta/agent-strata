import { describe, expect, test } from "bun:test";
import {
  appWrites,
  drift,
  frameStats,
  headLimit,
  jumpStats,
  median,
  openStats,
  placeError,
  placeOf,
  switchStats,
  type Sample,
  type Write,
} from "./metrics";

const sample = (t: number, over: Partial<Sample> = {}): Sample => ({
  t,
  st: 0,
  sh: 1000,
  ch: 500,
  ids: [],
  tops: [],
  rows: 0,
  drive: 0,
  ...over,
});

describe("frameStats", () => {
  test("gaps, the slow ones, and the blocked time beyond 50ms", () => {
    const s = [0, 16, 32, 132, 148, 218].map((t) => sample(t));
    const f = frameStats(s, 0, 1000);
    expect(f.frames).toBe(6);
    expect(f.maxGap).toBe(100);
    expect(f.over50).toBe(2);
    expect(f.over100).toBe(0);
    expect(f.blockedMs).toBe(50 + 20);
  });

  test("gaps are measured on frame timestamps when samples carry them", () => {
    // Samples taken after paint lag their frames by varying amounts; the gap is the frames'.
    const s = [sample(5, { ft: 0 }), sample(30, { ft: 16 }), sample(40, { ft: 33 })];
    expect(frameStats(s, 0, 100).maxGap).toBe(17);
  });

  test("only frames inside the window count", () => {
    const s = [0, 300, 316, 332].map((t) => sample(t));
    expect(frameStats(s, 300, 400).maxGap).toBe(16);
  });

  test("an empty window is zeros, not NaN", () => {
    expect(frameStats([], 0, 10)).toEqual({ frames: 0, maxGap: 0, p95Gap: 0, over50: 0, over100: 0, blockedMs: 0 });
  });
});

describe("appWrites", () => {
  test("the driver's own scrolls are not the app's", () => {
    const w: Write[] = [
      { t: 1, kind: "top", from: 100, to: 0, driver: true },
      { t: 2, kind: "top", from: 0, to: 40, driver: false },
      { t: 3, kind: "intoView", from: 40, to: 10, driver: false },
      { t: 99, kind: "top", from: 0, to: 500, driver: false },
    ];
    expect(appWrites(w, 0, 10)).toEqual({ count: 2, movedPx: 70 });
  });
});

describe("drift", () => {
  test("rows that move exactly as far as the driver scrolled have not drifted", () => {
    const s = [
      sample(0, { ids: ["a", "b"], tops: [0, 250] }),
      sample(16, { ids: ["a", "b"], tops: [100, 350], drive: 100 }),
    ];
    expect(drift(s, 0, 100)).toEqual({ frames: 1, maxAbs: 0, sumAbs: 0, over2: 0 });
  });

  test("a row above growing without compensation moves what the reader is looking at", () => {
    // No scroll at all, but the row in the middle of the viewport moved 300px.
    const s = [
      sample(0, { ids: ["a", "b"], tops: [-200, 240] }),
      sample(16, { ids: ["a", "b"], tops: [-200, 540] }),
    ];
    const d = drift(s, 0, 100);
    expect(d.maxAbs).toBe(300);
    expect(d.over2).toBe(1);
  });

  test("the row measured is the shared one nearest the middle, not the topmost", () => {
    // `a` grew in place: its top did not move, `b` below it (mid-viewport) did.
    const s = [
      sample(0, { ids: ["a", "b"], tops: [0, 260] }),
      sample(16, { ids: ["a", "b"], tops: [0, 400] }),
    ];
    expect(drift(s, 0, 100).maxAbs).toBe(140);
  });

  test("frames with no row in common are skipped rather than guessed", () => {
    const s = [sample(0, { ids: ["a"], tops: [0] }), sample(16, { ids: ["z"], tops: [0] })];
    expect(drift(s, 0, 100).frames).toBe(0);
  });
});

describe("openStats", () => {
  const order = Array.from({ length: 100 }, (_, i) => `t${i}`);

  test("an open that lands on the tail without painting the head", () => {
    const s = [
      sample(0),
      sample(50, { ids: ["t98", "t99"], tops: [0, 300], st: 500, sh: 1000, ch: 500 }),
    ];
    const o = openStats(s, order, 0, 50);
    expect(o.firstContentMs).toBe(50);
    expect(o.atTail).toBe(true);
    expect(o.headShown).toBe(false);
    expect(o.minIndexShown).toBe(98);
  });

  test("the crawl: painting the first turns on the way to the tail is flagged", () => {
    const s = [
      sample(10, { ids: ["t0"], tops: [0] }),
      sample(20, { ids: ["t99"], tops: [0], st: 500, sh: 1000, ch: 500 }),
    ];
    expect(openStats(s, order, 0, 20).headShown).toBe(true);
  });

  test("the column's padding below a pinned list is still the tail", () => {
    const s = [sample(10, { ids: ["t99"], tops: [100], st: 468, sh: 1000, ch: 500 })];
    expect(openStats(s, order, 0, 10).atTail).toBe(true);
  });

  test("a screen above the end is not the tail, even with the last turn showing", () => {
    const s = [sample(10, { ids: ["t98", "t99"], tops: [0, 400], st: 0, sh: 1000, ch: 500 })];
    expect(openStats(s, order, 0, 10).atTail).toBe(false);
  });

  test("a short session whose head is on the final screen did not pass through it", () => {
    const short = Array.from({ length: 9 }, (_, i) => `t${i}`);
    const s = [sample(10, { ids: ["t3", "t4", "t5", "t6", "t7", "t8"], tops: [0, 100, 200, 300, 400, 450], st: 0, sh: 500, ch: 500 })];
    expect(openStats(s, short, 0, 10).headShown).toBe(false);
  });

  test("a short session that showed turns well above where it settled did pass through them", () => {
    const short = Array.from({ length: 9 }, (_, i) => `t${i}`);
    const s = [
      sample(10, { ids: ["t0", "t1"], tops: [0, 300] }),
      sample(20, { ids: ["t6", "t7", "t8"], tops: [0, 200, 400], st: 600, sh: 1100, ch: 500 }),
    ];
    expect(openStats(s, short, 0, 20).headShown).toBe(true);
  });

  test("a tail screen that loses its top row as rows above grow is not the head", () => {
    // Measured on a real 9-turn session: pinned at the bottom showing 3..8,
    // then a row painted taller and the pinned tail moved on to 4..8.
    const short = Array.from({ length: 9 }, (_, i) => `t${i}`);
    const s = [
      sample(10, { ids: ["t3", "t4", "t5", "t6", "t7", "t8"], tops: [-30, 50, 130, 236, 403, 509], st: 286, sh: 978, ch: 692 }),
      sample(20, { ids: ["t4", "t5", "t6", "t7", "t8"], tops: [25, 131, 236, 403, 509], st: 413, sh: 1105, ch: 692 }),
    ];
    const o = openStats(s, short, 0, 20);
    expect(o.headShown).toBe(false);
    expect(o.atTail).toBe(true);
  });

  test("the crawl through a 20-turn session is still the head", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const s = [
      sample(10, { ids: ["t2"], tops: [0] }),
      sample(20, { ids: ["t18", "t19"], tops: [-200, 300], st: 9000, sh: 9500, ch: 500 }),
    ];
    expect(openStats(s, twenty, 0, 20).headShown).toBe(true);
  });

  test("not at the tail when the last turn is off screen, even at the end of the range", () => {
    const s = [sample(10, { ids: ["t97"], tops: [0], st: 500, sh: 1000, ch: 500 })];
    expect(openStats(s, order, 0, 10).atTail).toBe(false);
  });

  test("rows from another session are not first content", () => {
    const s = [sample(10, { ids: ["other"], tops: [0] }), sample(30, { ids: ["t99"], tops: [0] })];
    expect(openStats(s, order, 0, 30).firstContentMs).toBe(30);
  });

  test("blank frames are counted only after content has appeared", () => {
    const s = [sample(0), sample(10, { ids: ["t99"], tops: [0] }), sample(20), sample(30, { ids: ["t99"], tops: [0] })];
    expect(openStats(s, order, 0, 30).blankFrames).toBe(1);
  });

  test("the head is the turns further than max(5, 10%) from the end", () => {
    expect(headLimit(1600)).toBe(1440);
    expect(headLimit(38)).toBe(33);
  });
});

describe("switchStats", () => {
  test("stale, blank and first-correct frames around a switch", () => {
    const prev = new Set(["p1", "p2"]);
    const s = [
      sample(100, { ids: ["p1"], tops: [0] }),
      sample(116, { ids: ["p2"], tops: [0] }),
      sample(132),
      sample(148, { ids: ["n1"], tops: [0] }),
      sample(164),
      sample(180, { ids: ["n1"], tops: [0] }),
    ];
    expect(switchStats(s, prev, ["n1"], 100, 180)).toEqual({
      staleMs: 16,
      firstCorrectMs: 48,
      blankBefore: 1,
      blankAfter: 1,
    });
  });
});

describe("places and jumps", () => {
  test("a place is the top visible row and its offset", () => {
    const s = sample(0, { ids: ["a", "b"], tops: [-40, 200] });
    expect(placeOf(s)).toEqual({ id: "a", top: -40 });
    expect(placeError({ id: "a", top: -40 }, sample(0, { ids: ["x", "a"], tops: [-300, -20] }))).toBe(20);
    expect(placeError({ id: "a", top: 0 }, sample(0, { ids: ["x"], tops: [0] }))).toBeNull();
  });

  test("a jump's first move and where the target landed", () => {
    const s = [
      sample(0, { st: 5000 }),
      sample(16, { st: 5000 }),
      sample(48, { st: 2000, ids: ["x", "goal"], tops: [-100, 30] }),
      sample(64, { st: 2018, ids: ["goal"], tops: [12] }),
    ];
    expect(jumpStats(s, "goal", 10)).toEqual({ firstMoveMs: 38, landingError: 0 });
  });

  test("a click that changes nothing has no first move", () => {
    const s = [sample(0, { st: 10 }), sample(16, { st: 10, ids: ["x"], tops: [0] })];
    expect(jumpStats(s, "goal", 5)).toEqual({ firstMoveMs: null, landingError: null });
  });
});

test("median", () => {
  expect(median([3, 1, 2])).toBe(2);
  expect(median([4, 1, 2, 3])).toBe(2.5);
  expect(Number.isNaN(median([]))).toBe(true);
});
