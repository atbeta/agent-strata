import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROW_ESTIMATE,
  ROW_GAP,
  layoutKey,
  readRowHeights,
  recallReading,
  rememberReading,
  writeRowHeight,
} from "./transcript-layout";

/**
 * Switching panes remounts the transcript. The new list used to open on a
 * 100px guess for every row, so the turns on screen were stacked on top of
 * each other, and the scroll position — a pixel offset from a list that no
 * longer existed — put the window on the wrong rows. Then the measurements
 * landed and the whole column jumped.
 *
 * The place the reader was looking is a row and a distance into it. Row
 * heights belong to the pane and the session, so the list that mounts already
 * knows them.
 */
describe("a pane keeps the layout it already measured", () => {
  test("two panes showing one session do not share row heights", () => {
    writeRowHeight("pane-a:s1", "t", 640);
    writeRowHeight("pane-b:s1", "t", 180);
    expect(readRowHeights("pane-a:s1").get("t")).toBe(640);
    expect(readRowHeights("pane-b:s1").get("t")).toBe(180);
    expect(readRowHeights("pane-a:s2").get("t")).toBeUndefined();
  });

  test("a sub-pixel remeasure does not replace the stored height", () => {
    writeRowHeight("pane-a:s1", "u", 400);
    writeRowHeight("pane-a:s1", "u", 400.2);
    expect(readRowHeights("pane-a:s1").get("u")).toBe(400);
  });

  test("a reading remembers the row, and a pinned one forgets the pixel", () => {
    rememberReading("pane-a:s9", { pinned: false, turnId: "t4", offset: 12 });
    expect(recallReading("pane-a:s9")).toEqual({ pinned: false, turnId: "t4", offset: 12 });
    rememberReading("pane-a:s9", { pinned: true });
    expect(recallReading("pane-a:s9")).toEqual({ pinned: true });
    expect(recallReading("pane-a:s9-never-seen")).toBeUndefined();
  });

  test("both transcripts are the one transcript, seeded with the layout it measured", () => {
    // The math above does nothing if the list that mounts never hears it.
    // Both panes render TranscriptView, and a switch mounts a fresh row layout
    // and scroll owner under `layoutKey(paneId, sessionId)` — seeded from the
    // heights and the reading remembered under that key.
    for (const file of ["session-detail.tsx", "peer-transcript.tsx"]) {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      expect(src).toContain("<TranscriptView");
      expect(src).not.toContain("<Virtual");
    }
    const view = readFileSync(join(import.meta.dir, "transcript-view.tsx"), "utf8");
    expect(view).toContain("layoutKey(props.paneId, props.sessionId)");
    expect(view).toContain("seed: readRowHeights(key)");
    expect(view).toContain("onHeight: (id, height) => writeRowHeight(key, id, height)");
    expect(view).toContain("initial: recallReading(key) ?? { pinned: true }");
    expect(view).toContain("remember: (reading) => rememberReading(key, reading)");
    expect(view).toContain("estimate: ROW_ESTIMATE");
    expect(view).toContain("gap: ROW_GAP");
    // The key itself is what keeps one pane's reading out of another's.
    expect(layoutKey("pane-1", "s1")).toBe("pane-1:s1");
    expect(layoutKey("pane-2", "s1")).not.toBe(layoutKey("pane-1", "s1"));
  });
});
