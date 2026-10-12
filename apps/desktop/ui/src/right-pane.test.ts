import { describe, expect, test } from "bun:test";
import {
  FILES_PANEL_KEY,
  RAIL_DISMISSED_KEY,
  readFilesPanel,
  readRailDismissed,
  writeFilesPanel,
  writeRailDismissed,
} from "./right-pane";

/** A storage stand-in that can also be made to refuse, like private mode. */
function memory(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

const refusing = {
  getItem: () => {
    throw new Error("private mode");
  },
  setItem: () => {
    throw new Error("private mode");
  },
};

describe("the file browser", () => {
  test("starts closed, because nothing is stored yet", () => {
    expect(readFilesPanel(memory())).toBe(false);
  });

  test("survives a round trip through storage", () => {
    const s = memory();
    writeFilesPanel(true, s);
    expect(readFilesPanel(s)).toBe(true);
    expect(s.dump()[FILES_PANEL_KEY]).toBe("open");
    writeFilesPanel(false, s);
    expect(readFilesPanel(s)).toBe(false);
  });

  test("a closed browser is still closed in the next window", () => {
    // The regression: the panel was a signal inside the session view, so
    // `keyed` routing handed every new session a fresh `false` — or a fresh
    // `true` — and a reader who closed it found it open again on the next tab.
    const first = memory();
    writeFilesPanel(true, first);
    writeFilesPanel(false, first);
    const next = memory(first.dump());
    expect(readFilesPanel(next)).toBe(false);
  });

  test("the choice is the same for every session, not just the one it was made on", () => {
    // Nothing here is keyed by session id: one key, one window.
    const s = memory();
    writeFilesPanel(true, s);
    expect(Object.keys(s.dump())).toEqual([FILES_PANEL_KEY]);
  });

  test("a window that cannot store still opens and closes the browser", () => {
    expect(readFilesPanel(refusing)).toBe(false);
    expect(() => writeFilesPanel(true, refusing)).not.toThrow();
  });
});

describe("the rail's dismissal", () => {
  test("stands until the reader opens a pane again", () => {
    const s = memory();
    expect(readRailDismissed(s)).toBe(false);
    writeRailDismissed(true, s);
    expect(readRailDismissed(s)).toBe(true);
    expect(s.dump()[RAIL_DISMISSED_KEY]).toBe("1");
    writeRailDismissed(false, s);
    expect(readRailDismissed(s)).toBe(false);
  });

  test("outlives the session that closed it", () => {
    const first = memory();
    writeRailDismissed(true, first);
    expect(readRailDismissed(memory(first.dump()))).toBe(true);
  });

  test("a window that cannot store still reads a dismissal", () => {
    expect(readRailDismissed(refusing)).toBe(false);
    expect(() => writeRailDismissed(true, refusing)).not.toThrow();
  });
});
