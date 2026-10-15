import { describe, expect, test } from "bun:test";
import { PINS_KEY, readPins, togglePin, writePins } from "./pins";

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

describe("pinned sessions", () => {
  test("is empty when nothing is stored", () => {
    expect(readPins(store())).toEqual([]);
  });

  test("round trips the id list", () => {
    const s = store();
    writePins(["a", "b"], s);
    expect(readPins(s)).toEqual(["a", "b"]);
  });

  test("malformed and mistyped storage read as no pins", () => {
    expect(readPins(store({ [PINS_KEY]: "not json" }))).toEqual([]);
    expect(readPins(store({ [PINS_KEY]: "{}" }))).toEqual([]);
    expect(readPins(store({ [PINS_KEY]: "[1, 2, null]" }))).toEqual([]);
  });

  test("blank and duplicate entries are dropped", () => {
    expect(readPins(store({ [PINS_KEY]: '["a", "", "a", "b"]' }))).toEqual(["a", "b"]);
  });

  test("toggling a new pin puts it first and toggling again removes it", () => {
    expect(togglePin(["a"], "b")).toEqual(["b", "a"]);
    expect(togglePin(["b", "a"], "b")).toEqual(["a"]);
  });
});
