import { describe, expect, test } from "bun:test";
import {
  clampRailWidth,
  readRailWidth,
  RAIL_CEILING,
  RAIL_DEFAULT,
  RAIL_MIN,
  RAIL_WIDTH_KEY,
  writeRailWidth,
} from "./rail-width";

/** A storage stand-in that can also be made to refuse, like private mode. */
function memory(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

describe("the rail's width", () => {
  test("keeps a width the reader chose", () => {
    expect(clampRailWidth(560, 1280)).toBe(560);
    expect(clampRailWidth(430.6, 1280)).toBe(431);
  });

  test("will not shrink below the floor or grow past the ceiling", () => {
    expect(clampRailWidth(40, 1280)).toBe(RAIL_MIN);
    expect(clampRailWidth(5000, 1280)).toBe(Math.round(1280 * RAIL_CEILING));
  });

  test("yields room to the transcript when the window narrows", () => {
    // The width is remembered, not followed: a 560px rail asked for on a wide
    // window cannot keep 560px of a 800px one.
    expect(clampRailWidth(560, 800)).toBe(Math.round(800 * RAIL_CEILING));
    // And it never goes so small that the window itself is gone.
    expect(clampRailWidth(900, 400)).toBe(RAIL_MIN);
  });

  test("falls back to the default when the stored value is not a number", () => {
    expect(clampRailWidth(Number("wide"), 1280)).toBe(RAIL_DEFAULT);
    expect(clampRailWidth(Number.NaN, 1280)).toBe(RAIL_DEFAULT);
  });

  test("survives a round trip through storage", () => {
    const s = memory();
    writeRailWidth(512, s);
    expect(readRailWidth(1280, s)).toBe(512);
    expect(s.dump()[RAIL_WIDTH_KEY]).toBe("512");
  });

  test("a session that cannot store still reads a usable width", () => {
    const refusing = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
    };
    expect(readRailWidth(1280, refusing)).toBe(RAIL_DEFAULT);
    expect(() => writeRailWidth(512, refusing)).not.toThrow();
  });

  test("an empty store gets the default rather than zero", () => {
    expect(readRailWidth(1280, memory())).toBe(RAIL_DEFAULT);
  });
});