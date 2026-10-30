import { describe, expect, test } from "bun:test";
import { shareTurnIds } from "./turn-ids";

describe("turn id structural sharing", () => {
  test("an unchanged id sequence keeps the previous array", () => {
    const previous = ["a", "b"];
    expect(shareTurnIds(previous, [...previous])).toBe(previous);
  });

  test("adding, removing, or reordering turns replaces the array", () => {
    const previous = ["a", "b"];
    expect(shareTurnIds(previous, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(shareTurnIds(previous, ["a"])).toEqual(["a"]);
    expect(shareTurnIds(previous, ["b", "a"])).toEqual(["b", "a"]);
  });
});
