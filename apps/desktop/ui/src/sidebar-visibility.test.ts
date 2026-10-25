import { describe, expect, test } from "bun:test";
import { readSidebarOpen, SIDEBAR_KEY, writeSidebarOpen } from "./sidebar-visibility";

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
