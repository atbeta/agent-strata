import { describe, expect, test } from "bun:test";
import { magnifyFalloff, magnifiedWidth, navSteps, railOverflows } from "./prompt-nav";

describe("the prompt rail", () => {
  test("a line is longest under the pointer and back to rest at the edge of the falloff", () => {
    expect(magnifyFalloff(0, 50)).toBe(1);
    expect(magnifyFalloff(50, 50)).toBe(0);
    expect(magnifyFalloff(80, 50)).toBe(0);
    const mid = magnifyFalloff(25, 50);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(magnifiedWidth(8, 20, 0, 50)).toBe(20);
    expect(magnifiedWidth(8, 20, 50, 50)).toBe(8);
  });

  test("scroll chrome appears only once the ticks are taller than the rail", () => {
    expect(railOverflows(10, 8, 360)).toBe(false);
    expect(railOverflows(46, 8, 360)).toBe(true);
    expect(railOverflows(0, 8, 360)).toBe(false);
  });

  test("the arrows step one prompt and the dots are the two ends", () => {
    const ids = ["a", "b", "c"];
    expect(navSteps(ids, "b")).toEqual({
      previousId: "a",
      nextId: "c",
      firstId: "a",
      lastId: "c",
    });
    expect(navSteps(ids, "a")?.previousId).toBeUndefined();
    expect(navSteps(ids, "c")?.nextId).toBeUndefined();
    expect(navSteps(ids, undefined)?.nextId).toBe("a");
  });
});
