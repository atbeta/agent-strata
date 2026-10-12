import { describe, expect, test } from "bun:test";
import {
  readPanelOpen,
  readPanelTab,
  SIDE_PANEL_KEY,
  SIDE_PANEL_TAB_KEY,
  writePanelOpen,
  writePanelTab,
} from "./right-pane";

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

describe("side panel state", () => {
  test("is closed when nothing is stored", () => {
    const s = store();
    expect(readPanelOpen(s)).toBe(false);
  });

  test("round trips open and closed", () => {
    const s = store();
    writePanelOpen(true, s);
    expect(s.getItem(SIDE_PANEL_KEY)).toBe("open");
    expect(readPanelOpen(s)).toBe(true);
    writePanelOpen(false, s);
    expect(readPanelOpen(s)).toBe(false);
  });

  test("any value other than open reads as closed", () => {
    expect(readPanelOpen(store({ [SIDE_PANEL_KEY]: "closed" }))).toBe(false);
    expect(readPanelOpen(store({ [SIDE_PANEL_KEY]: "yes" }))).toBe(false);
  });

  test("defaults the tab to changes", () => {
    const s = store();
    expect(readPanelTab(s)).toBe("changes");
  });

  test("round trips the tab", () => {
    const s = store();
    writePanelTab("files", s);
    expect(s.getItem(SIDE_PANEL_TAB_KEY)).toBe("files");
    expect(readPanelTab(s)).toBe("files");
    writePanelTab("changes", s);
    expect(readPanelTab(s)).toBe("changes");
  });

  test("an unknown stored tab falls back to changes", () => {
    expect(readPanelTab(store({ [SIDE_PANEL_TAB_KEY]: "outline" }))).toBe("changes");
  });

  test("old panel keys are ignored", () => {
    const s = store({ "strata.files-panel": "true", "strata.rail-dismissed": "true" });
    expect(readPanelOpen(s)).toBe(false);
    expect(readPanelTab(s)).toBe("changes");
  });
});
