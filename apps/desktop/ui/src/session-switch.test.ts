import { describe, expect, test } from "bun:test";
import { readMru, recentOrder, stepIndex, touchMru, writeMru, type MruStorage } from "./session-switch";

const rows = [
  { id: "old", lastTs: 1 },
  { id: "new", lastTs: 50 },
  { id: "mid", lastTs: 20 },
];

describe("recent session order", () => {
  test("visits come first and the open session stays at the front", () => {
    expect(recentOrder(rows, ["mid", "old"], "new")).toEqual(["new", "mid", "old"]);
  });

  test("without visits, the newest activity is first after the open session", () => {
    expect(recentOrder(rows, [], "old")).toEqual(["old", "new", "mid"]);
  });

  test("an unknown visit and a missing current session are ignored", () => {
    expect(recentOrder(rows, ["gone", "mid", "mid"], "child")).toEqual(["mid", "new", "old"]);
  });

  test("the first Tab leaves the current session, then wraps", () => {
    expect(stepIndex({ length: 3, at: null, delta: 1, currentAtFront: true })).toBe(1);
    expect(stepIndex({ length: 3, at: 1, delta: 1, currentAtFront: true })).toBe(2);
    expect(stepIndex({ length: 3, at: 2, delta: 1, currentAtFront: true })).toBe(0);
    expect(stepIndex({ length: 3, at: null, delta: -1, currentAtFront: true })).toBe(2);
  });

  test("a child session starts the gesture on the newest root", () => {
    expect(stepIndex({ length: 3, at: null, delta: 1, currentAtFront: false })).toBe(0);
  });

  test("one session has nowhere to go", () => {
    expect(stepIndex({ length: 1, at: null, delta: 1, currentAtFront: true })).toBeNull();
  });

  test("a visit is remembered at the front", () => {
    const box: MruStorage = {
      getItem: () => null,
      setItem: () => {},
    };
    let raw = "";
    box.getItem = () => raw || null;
    box.setItem = (_key, value) => {
      raw = value;
    };
    writeMru(touchMru(readMru(box), "a"), box);
    writeMru(touchMru(readMru(box), "b"), box);
    expect(readMru(box)).toEqual(["b", "a"]);
  });
});
