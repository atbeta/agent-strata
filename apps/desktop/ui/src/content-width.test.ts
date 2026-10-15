import { describe, expect, test } from "bun:test";
import {
  clampContentWidth,
  CONTENT_W_DEFAULT,
  CONTENT_W_MAX,
  CONTENT_W_MIN,
  CONTENT_WIDTH_KEY,
  readContentWidth,
  writeContentWidth,
} from "./content-width";

function store(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("the reading column's width", () => {
  test("reads the default when nothing is stored", () => {
    expect(readContentWidth(store())).toBe(CONTENT_W_DEFAULT);
  });

  test("survives a round trip through storage", () => {
    const s = store();
    writeContentWidth(980, s);
    expect(s.getItem(CONTENT_WIDTH_KEY)).toBe("980");
    expect(readContentWidth(s)).toBe(980);
  });

  test("keeps a width the reader chose inside the bounds", () => {
    expect(clampContentWidth(CONTENT_W_MIN)).toBe(CONTENT_W_MIN);
    expect(clampContentWidth(CONTENT_W_MAX)).toBe(CONTENT_W_MAX);
  });

  test("a width outside the bounds lands on the nearest edge", () => {
    expect(clampContentWidth(10)).toBe(CONTENT_W_MIN);
    expect(clampContentWidth(99999)).toBe(CONTENT_W_MAX);
    expect(readContentWidth(store({ [CONTENT_WIDTH_KEY]: "10" }))).toBe(CONTENT_W_MIN);
  });

  test("a stored value that is not a number falls back to the default", () => {
    expect(readContentWidth(store({ [CONTENT_WIDTH_KEY]: "wide" }))).toBe(CONTENT_W_DEFAULT);
  });
});
