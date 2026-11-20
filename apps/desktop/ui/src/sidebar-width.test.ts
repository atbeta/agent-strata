import { describe, expect, test } from "bun:test";
import {
  clampSidebarWidth,
  readSidebarWidth,
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  writeSidebarWidth,
} from "./sidebar-width";

function memory(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    dump: () => Object.fromEntries(map),
  };
}

describe("the session list's width", () => {
  test("defaults to the existing 300px and rounds a chosen width", () => {
    expect(readSidebarWidth(1280, memory())).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(clampSidebarWidth(340.6, 1280)).toBe(341);
  });

  test("keeps the width within its floor and ceiling", () => {
    expect(clampSidebarWidth(20, 1280)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(5000, 1280)).toBe(SIDEBAR_WIDTH_MAX);
    expect(clampSidebarWidth(500, 800)).toBe(400);
    expect(clampSidebarWidth(500, 400)).toBe(SIDEBAR_WIDTH_MIN);
  });

  test("falls back to a usable default for a missing or invalid value", () => {
    expect(readSidebarWidth(1280, memory({ [SIDEBAR_WIDTH_KEY]: "wide" }))).toBe(
      SIDEBAR_WIDTH_DEFAULT,
    );
    expect(readSidebarWidth(400, memory())).toBe(SIDEBAR_WIDTH_MIN);
  });

  test("round trips the preference through storage", () => {
    const storage = memory();
    writeSidebarWidth(372, storage);
    expect(storage.dump()[SIDEBAR_WIDTH_KEY]).toBe("372");
    expect(readSidebarWidth(1280, storage)).toBe(372);
  });

  test("still works when storage refuses access", () => {
    const refusing = {
      getItem: () => {
        throw new Error("private mode");
      },
      setItem: () => {
        throw new Error("private mode");
      },
    };
    expect(readSidebarWidth(1280, refusing)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(() => writeSidebarWidth(372, refusing)).not.toThrow();
  });
});
