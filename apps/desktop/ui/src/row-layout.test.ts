import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createRowLayout } from "./row-layout";

// The root must outlive the assertions: disposing it tears down the memos
// inside the layout, and committed heights would stop recomputing offsets.
const layout = (
  ids: readonly string[],
  opts?: {
    joined?: (i: number) => boolean;
    estimates?: () => ReadonlyMap<string, number>;
    seed?: ReadonlyMap<string, number>;
    onHeight?: (id: string, h: number) => void;
  },
) => {
  let out!: ReturnType<typeof createRowLayout>;
  createRoot(() => {
    out = createRowLayout({ ids: () => ids, estimate: 100, gap: 10, ...opts });
  });
  return out;
};

describe("row layout", () => {
  test("offsets fold the estimate and the gap until rows are measured", () => {
    const l = layout(["a", "b", "c"]);
    expect([...l.offsets()]).toEqual([0, 110, 220, 330]);
    expect(l.end()).toBe(330);
    expect(l.heightOf(1)).toBe(100);
  });

  test("seeded and committed heights replace the estimate in the prefix sum", () => {
    const l = layout(["a", "b", "c"], { seed: new Map([["a", 300]]) });
    expect([...l.offsets()]).toEqual([0, 310, 420, 530]);
    l.commit(new Map([["b", 50]]));
    expect([...l.offsets()]).toEqual([0, 310, 370, 480]);
  });

  test("commit ignores sub-pixel churn and reports only changed ids", () => {
    const seen: string[] = [];
    const l = layout(["a", "b"], { seed: new Map([["a", 300]]), onHeight: (id) => seen.push(id) });
    l.commit(new Map([["a", 300.4]]));
    expect(seen).toEqual([]);
    expect(l.offsets()[1]).toBe(310);
    l.commit(new Map([["a", 300.4], ["b", 500]]));
    expect(seen).toEqual(["b"]);
  });

  test("one commit changes offsets identity once and reports only real changes", () => {
    const seen: string[] = [];
    const l = layout(["a", "b", "c"], {
      seed: new Map([["a", 300]]),
      onHeight: (id) => seen.push(id),
    });
    const before = l.offsets();
    l.commit(
      new Map([
        ["a", 300.4], // below the noise floor: not a change
        ["b", 55], // a change vs the estimate
        ["c", 900], // a change vs the estimate
      ]),
    );
    const after = l.offsets();
    expect(after).not.toBe(before);
    expect(l.offsets()).toBe(after); // second read returns the same array
    expect(seen).toEqual(["b", "c"]);
  });

  test("a first measurement counts as a change against the estimate", () => {
    const seen: string[] = [];
    const l = layout(["a"], { onHeight: (id) => seen.push(id) });
    l.commit(new Map([["a", 100.4]])); // estimate is 100; |Δ| < 0.5 → ignored
    expect(seen).toEqual([]);
    expect(l.isMeasured("a")).toBe(false);
    l.commit(new Map([["a", 200]]));
    expect(seen).toEqual(["a"]);
    expect(l.isMeasured("a")).toBe(true);
  });

  test("a row its successor continues leaves no gap; the rest keep theirs", () => {
    // A 25-message turn is rows "a", "a#1", "a#2" — joined inside, gapped around.
    const l = layout(["t0", "a", "a#1", "a#2", "t4"], {
      joined: (i) => i === 1 || i === 2, // "a#1" and "a#2" continue "a"
    });
    expect([...l.offsets()]).toEqual([0, 110, 210, 310, 420, 530]);
    expect(l.end()).toBe(530);
    l.commit(new Map([["a#1", 200]]));
    expect([...l.offsets()]).toEqual([0, 110, 210, 410, 520, 630]);
  });

  test("indexOf follows the id list, not a stale map", () => {
    let ids = ["a", "b"];
    createRoot(() => {
      const l = createRowLayout({ ids: () => ids, estimate: 100, gap: 10 });
      expect(l.indexOf("b")).toBe(1);
      expect(l.indexOf("zzz")).toBe(-1);
      ids = ["x", "a", "b"];
      expect(l.indexOf("a")).toBe(1);
    });
  });

  test("a row with an estimate of its own uses it", () => {
    // Rows are not one size: a turn's first segment carries the turn's own
    // block and its continuations carry messages alone. One number for every
    // row makes the scrollbar wrong by the widest of them.
    let estimates = new Map([
      ["a", 150],
      ["b", 760],
    ]);
    const l = layout(["a", "b"], { estimates: () => estimates });
    expect([...l.offsets()]).toEqual([0, 160, 930]);
    expect(l.heightOf(0)).toBe(150);
    expect(l.heightOf(1)).toBe(760);
    // A measurement still wins over the estimate.
    l.commit(new Map([["a", 300]]));
    expect(l.heightOf(0)).toBe(300);
  });

  test("a new estimate rebuilds the prefix sum", () => {
    let estimates = new Map([["a", 150]]);
    const l = layout(["a", "b"], { estimates: () => estimates });
    expect(l.end()).toBe(270);
    estimates = new Map([["a", 400]]);
    expect(l.end()).toBe(520);
  });

  test("a measurement that matches the row's own estimate is not a change", () => {
    const seen: string[] = [];
    const l = layout(["a"], {
      estimates: () => new Map([["a", 150]]),
      onHeight: (id) => seen.push(id),
    });
    l.commit(new Map([["a", 150]]));
    expect(seen).toEqual([]);
    expect(l.isMeasured("a")).toBe(false);
  });

  test("rowAt edges: before the first row, inside one, past the end", () => {
    const l = layout(["a", "b", "c"], { seed: new Map([["a", 200]]) });
    // rows: a [0,210) b [210,320) c [320,430)
    expect(l.rowAt(-50)).toBe(0);
    expect(l.rowAt(0)).toBe(0);
    expect(l.rowAt(209)).toBe(0);
    expect(l.rowAt(210)).toBe(1);
    expect(l.rowAt(429)).toBe(2);
    expect(l.rowAt(430)).toBe(3); // past the end
    expect(l.rowAt(10_000)).toBe(3);
  });
});
