import { describe, expect, test } from "bun:test";
import { stableKeys } from "./keyed";

describe("stableKeys", () => {
  test("the same keys hand back the previous array", () => {
    const prev = ["a", "b"];
    expect(stableKeys(prev, ["a", "b"])).toBe(prev);
  });

  test("a changed, added or missing key is a new array", () => {
    const prev = ["a", "b"];
    const next = ["a", "c"];
    expect(stableKeys(prev, next)).toBe(next);
    expect(stableKeys(prev, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(stableKeys(prev, ["a"])).toEqual(["a"]);
  });

  test("nothing before is a new array", () => {
    const next = ["a"];
    expect(stableKeys(undefined, next)).toBe(next);
  });
});
