import { describe, expect, test } from "bun:test";
import { admit, dismiss, readBoard, writeBoard } from "./session-board";

function store(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("session board", () => {
  test("reads nothing as an empty row", () => {
    expect(readBoard(store())).toEqual([]);
    expect(readBoard(store({ "strata.board": "nope" }))).toEqual([]);
    expect(readBoard(store({ "strata.board": "{}" }))).toEqual([]);
  });

  test("drops blanks and repeats", () => {
    expect(readBoard(store({ "strata.board": JSON.stringify(["a", "", "a", 2, "b"]) }))).toEqual(["a", "b"]);
  });

  test("round trips", () => {
    const s = store();
    writeBoard(["a", "b"], s);
    expect(readBoard(s)).toEqual(["a", "b"]);
  });

  test("admit keeps the same array when the session is already open", () => {
    const ids = ["a", "b"];
    expect(admit(ids, "b")).toBe(ids);
    expect(admit(ids, "c")).toEqual(["a", "b", "c"]);
  });

  test("dismiss moves focus to the session on the right", () => {
    expect(dismiss(["a", "b", "c"], "b", "b")).toEqual({ ids: ["a", "c"], active: "c" });
  });

  test("dismiss of the last session moves focus left", () => {
    expect(dismiss(["a", "b"], "b", "b")).toEqual({ ids: ["a"], active: "a" });
  });

  test("dismiss of an unfocused session leaves focus where it is", () => {
    expect(dismiss(["a", "b", "c"], "a", "c")).toEqual({ ids: ["b", "c"], active: "c" });
  });

  test("dismiss of the only session leaves the overview", () => {
    expect(dismiss(["a"], "a", "a")).toEqual({ ids: [], active: null });
  });
});
