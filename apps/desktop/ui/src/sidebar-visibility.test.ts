import { describe, expect, test } from "bun:test";
import {
  everyGroupFolded,
  foldGroups,
  readSidebarOpen,
  SIDEBAR_KEY,
  writeSidebarOpen,
} from "./sidebar-visibility";

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

describe("the left column's state", () => {
  test("is open when nothing is stored", () => {
    // The list is the way into everything, so a window that has never been
    // told otherwise shows it.
    expect(readSidebarOpen(store())).toBe(true);
  });

  test("round trips open and closed", () => {
    const s = store();
    writeSidebarOpen(false, s);
    expect(s.getItem(SIDEBAR_KEY)).toBe("closed");
    expect(readSidebarOpen(s)).toBe(false);
    writeSidebarOpen(true, s);
    expect(s.getItem(SIDEBAR_KEY)).toBe("open");
    expect(readSidebarOpen(s)).toBe(true);
  });

  test("any value other than closed reads as open", () => {
    expect(readSidebarOpen(store({ [SIDEBAR_KEY]: "yes" }))).toBe(true);
  });
});

describe("the run of folders", () => {
  test("is folded only when every folder is", () => {
    const folded = new Set(["a", "b"]);
    expect(everyGroupFolded(["a", "b"], folded)).toBe(true);
    expect(everyGroupFolded(["a"], folded)).toBe(true);
    expect(everyGroupFolded(["a", "b", "c"], folded)).toBe(false);
    expect(everyGroupFolded([], folded)).toBe(false);
  });

  test("folds and unfolds the named groups, and only those", () => {
    const folded = new Set(["elsewhere"]);
    const all = foldGroups(["a", "b"], folded, true);
    expect([...all]).toEqual(["elsewhere", "a", "b"]);
    const one = foldGroups(["a"], all, false);
    expect(one.has("a")).toBe(false);
    expect(one.has("b")).toBe(true);
    expect(one.has("elsewhere")).toBe(true);
    // The input is not mutated: the signal's Set is the previous frame.
    expect(folded.size).toBe(1);
  });
});
