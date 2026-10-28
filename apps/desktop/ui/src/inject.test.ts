import { describe, expect, test } from "bun:test";
import type { Turn } from "./api";
import { carryLive, injectionBatches, INJECT_BATCH, INJECT_FIRST, INJECT_MAX } from "./inject";

const turn = (turn_id: string): Turn => ({
  turn_id,
  user: [{ type: "text", text: turn_id }],
  assistant: [],
  tool_calls: [],
});

describe("injectionBatches", () => {
  test("a session that fits lands in one batch", () => {
    expect(injectionBatches(2)).toEqual([2]);
    expect(injectionBatches(INJECT_FIRST)).toEqual([INJECT_FIRST]);
  });

  test("a long session grows a batch at a time", () => {
    const plan = injectionBatches(38);
    expect(plan[0]).toBe(INJECT_FIRST);
    expect(plan[plan.length - 1]).toBe(38);
    expect(plan.length).toBe(38 - INJECT_FIRST + 1);
  });

  test("a session past the limit lands whole, in one piece", () => {
    expect(injectionBatches(INJECT_MAX + 1)).toEqual([INJECT_MAX + 1]);
  });

  test("an empty session is one empty batch", () => {
    expect(injectionBatches(0)).toEqual([0]);
  });

  test("the plan always ends at the whole session and never goes backwards", () => {
    for (const n of [0, 1, 3, 4, 5, 7, 8, 37, 38, 96]) {
      const plan = injectionBatches(n);
      expect(plan[plan.length - 1]).toBe(n);
      for (let i = 1; i < plan.length; i++) {
        expect(plan[i]!).toBeGreaterThan(plan[i - 1]!);
        // The first batch may be larger than the rest: it is the one that has
        // to cover the tail preview the reader was already looking at.
        expect(plan[i]! - plan[i - 1]!).toBeLessThanOrEqual(i === 1 ? INJECT_FIRST : INJECT_BATCH);
      }
    }
  });

  test("a session that would take more frames than one landing is not split", () => {
    // 96 turns in batches of 4 is 24 frames; the whole landing is one.
    expect(injectionBatches(INJECT_MAX).length).toBeGreaterThan(1);
    expect(injectionBatches(INJECT_MAX + 1).length).toBe(1);
  });
});

describe("carryLive", () => {
  test("a reply still being written survives the batch that replaces the view", () => {
    const known = new Set(["a", "b"]);
    expect(carryLive([turn("c")], known).map((t) => t.turn_id)).toEqual(["c"]);
  });

  test("a turn the view holds but has not shown yet is not carried twice", () => {
    // The view has every turn; only the ones it does not hold are missing.
    const known = new Set(["a", "b", "c"]);
    expect(carryLive([turn("b"), turn("c")], known)).toEqual([]);
  });

  test("nothing to carry leaves nothing to add", () => {
    const known = new Set(["a"]);
    expect(carryLive(undefined, known)).toEqual([]);
    expect(carryLive([], known)).toEqual([]);
  });
});
