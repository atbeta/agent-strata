import { describe, expect, test } from "bun:test";
import { pieSectorPath } from "./context-pie";

describe("pieSectorPath", () => {
  test("25% sweeps a quarter arc to the 3 o'clock point", () => {
    expect(pieSectorPath(25, 4.75)).toBe("M 8 8 L 8 3.25 A 4.75 4.75 0 0 1 12.75 8 Z");
  });

  test("50% is a half circle ending at 6 o'clock", () => {
    expect(pieSectorPath(50, 4.75)).toBe("M 8 8 L 8 3.25 A 4.75 4.75 0 0 1 8 12.75 Z");
  });

  test("75% takes the large arc and ends at 9 o'clock", () => {
    expect(pieSectorPath(75, 4.75)).toBe("M 8 8 L 8 3.25 A 4.75 4.75 0 1 1 3.25 8 Z");
  });
});
