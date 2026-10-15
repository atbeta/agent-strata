import { describe, expect, test } from "bun:test";
import {
  activeSessionOf,
  applyLayoutPreset,
  assignSessionToWorkspace,
  clampSplitRatio,
  closePane,
  createInitialWorkspace,
  detectPreset,
  focusPane,
  listLeaves,
  PANES_STORAGE_KEY,
  RATIO_MAX,
  RATIO_MIN,
  readPaneWorkspace,
  resizeSplit,
  setPaneMode,
  setPaneSession,
  splitPane,
  toggleZoomPane,
  writePaneWorkspace,
} from "./pane-tree";

function memStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe("pane workspace model", () => {
  test("starts in single mode with one leaf", () => {
    const ws = createInitialWorkspace("s1");
    expect(ws.mode).toBe("single");
    expect(listLeaves(ws.root)).toEqual([{ kind: "leaf", id: "pane-1", sessionId: "s1" }]);
    expect(activeSessionOf(ws, "fallback")).toBe("s1");
    expect(detectPreset(ws)).toBe("single");
  });

  test("in single mode, selecting a session from the sidebar replaces the current session without adding panes", () => {
    let ws = createInitialWorkspace("s1");
    ws = assignSessionToWorkspace(ws, "s2");
    ws = assignSessionToWorkspace(ws, "s3");
    expect(ws.mode).toBe("single");
    expect(listLeaves(ws.root)).toHaveLength(1);
    expect(listLeaves(ws.root)[0]?.sessionId).toBe("s3");
  });

  test("applying cols-2, rows-2, and grid-4 presets builds the right tree and seeds sessions", () => {
    const base = createInitialWorkspace("s1");

    const cols = applyLayoutPreset(base, "cols-2", "s1", ["s1", "s2", "s3"]);
    expect(cols.mode).toBe("multiplex");
    expect(detectPreset(cols)).toBe("cols-2");
    expect(listLeaves(cols.root).map((l) => l.sessionId)).toEqual(["s1", "s2"]);

    const rows = applyLayoutPreset(cols, "rows-2", "s1", ["s1", "s2", "s3"]);
    expect(rows.mode).toBe("multiplex");
    expect(detectPreset(rows)).toBe("rows-2");
    expect(listLeaves(rows.root).map((l) => l.sessionId)).toEqual(["s1", "s2"]);

    const grid = applyLayoutPreset(rows, "grid-4", "s1", ["s1", "s2", "s3", "s4"]);
    expect(grid.mode).toBe("multiplex");
    expect(detectPreset(grid)).toBe("grid-4");
    expect(listLeaves(grid.root).map((l) => l.sessionId)).toEqual(["s1", "s2", "s3", "s4"]);

    const backToSingle = applyLayoutPreset(grid, "single", "s1");
    expect(backToSingle.mode).toBe("single");
    expect(detectPreset(backToSingle)).toBe("single");
    // Preserves the underlying tree so switching back to multiplex restores all 4 panes
    expect(listLeaves(backToSingle.root)).toHaveLength(4);
    const restored = setPaneMode(backToSingle, "multiplex", "s1");
    expect(restored.mode).toBe("multiplex");
    expect(listLeaves(restored.root).map((l) => l.sessionId)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  test("in multiplex mode, sidebar click fills an empty slot first, then replaces the focused pane", () => {
    let ws = applyLayoutPreset(createInitialWorkspace("s1"), "cols-2", "s1");
    expect(listLeaves(ws.root).map((l) => l.sessionId)).toEqual(["s1", null]);

    // Pane 2 is empty, so selecting s2 fills pane 2 and focuses it
    ws = assignSessionToWorkspace(ws, "s2");
    expect(listLeaves(ws.root).map((l) => l.sessionId)).toEqual(["s1", "s2"]);
    expect(ws.focusedPaneId).toBe("pane-2");

    // Now all slots are full; selecting s3 replaces the focused pane (pane-2)
    ws = assignSessionToWorkspace(ws, "s3");
    expect(listLeaves(ws.root).map((l) => l.sessionId)).toEqual(["s1", "s3"]);
    expect(ws.focusedPaneId).toBe("pane-2");

    // Focusing pane-1 and selecting s4 replaces pane-1
    ws = focusPane(ws, "pane-1");
    ws = assignSessionToWorkspace(ws, "s4");
    expect(listLeaves(ws.root).map((l) => l.sessionId)).toEqual(["s4", "s3"]);
  });

  test("free splitting and closing panes behaves like a terminal multiplexer", () => {
    let ws = createInitialWorkspace("s1");
    ws = splitPane(ws, "pane-1", "row", "s2");
    expect(ws.mode).toBe("multiplex");
    expect(listLeaves(ws.root)).toHaveLength(2);
    const secondId = ws.focusedPaneId;
    expect(secondId).not.toBe("pane-1");

    // Split the second pane vertically to make a 3-pane layout (left + top-right/bottom-right)
    ws = splitPane(ws, secondId, "col", "s3");
    expect(listLeaves(ws.root)).toHaveLength(3);
    expect(detectPreset(ws)).toBe("custom");
    const thirdId = ws.focusedPaneId;

    // Close the focused 3rd pane -> focus moves back to neighbour, 2 panes remain
    ws = closePane(ws, thirdId);
    expect(listLeaves(ws.root)).toHaveLength(2);
    expect(ws.mode).toBe("multiplex");
    expect(ws.focusedPaneId).toBe(secondId);

    // Close the 2nd pane -> only 1 pane remains, automatically returns to single mode
    ws = closePane(ws, secondId);
    expect(listLeaves(ws.root)).toHaveLength(1);
    expect(ws.mode).toBe("single");
    expect(ws.focusedPaneId).toBe("pane-1");
  });

  test("resizing a split clamps to safe bounds", () => {
    let ws = applyLayoutPreset(createInitialWorkspace("s1"), "cols-2", "s1", ["s1", "s2"]);
    ws = resizeSplit(ws, "split-root", 0.99);
    expect(ws.root.kind === "split" && ws.root.ratio).toBe(RATIO_MAX);

    ws = resizeSplit(ws, "split-root", 0.01);
    expect(ws.root.kind === "split" && ws.root.ratio).toBe(RATIO_MIN);

    ws = resizeSplit(ws, "split-root", 0.65);
    expect(ws.root.kind === "split" && ws.root.ratio).toBe(0.65);
  });

  test("zooming a pane toggles without losing the split tree", () => {
    let ws = applyLayoutPreset(createInitialWorkspace("s1"), "grid-4", "s1", ["s1", "s2", "s3", "s4"]);
    ws = toggleZoomPane(ws, "pane-3");
    expect(ws.zoomedPaneId).toBe("pane-3");
    expect(ws.focusedPaneId).toBe("pane-3");
    expect(listLeaves(ws.root)).toHaveLength(4);

    // Toggling again unzooms
    ws = toggleZoomPane(ws, "pane-3");
    expect(ws.zoomedPaneId).toBeNull();
  });

  test("persists and restores from storage safely", () => {
    const store = memStorage();
    let ws = applyLayoutPreset(createInitialWorkspace("s1"), "grid-4", "s1", ["s1", "s2", "s3", "s4"]);
    ws = setPaneSession(ws, "pane-4", "s9");
    writePaneWorkspace(ws, store);

    const loaded = readPaneWorkspace(store);
    expect(loaded.mode).toBe("multiplex");
    expect(listLeaves(loaded.root).map((l) => l.sessionId)).toEqual(["s1", "s2", "s3", "s9"]);
    expect(loaded.focusedPaneId).toBe("pane-4");

    // Corrupted JSON falls back cleanly
    store.setItem(PANES_STORAGE_KEY, "{not-json");
    expect(readPaneWorkspace(store).mode).toBe("single");
  });
});
