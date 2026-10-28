import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROW_ESTIMATE,
  ROW_GAP,
  anchorAt,
  anchorFromOffsets,
  pinScroll,
  placeReading,
  readingFromScroll,
  prefixOffsets,
  readRowHeights,
  recallReading,
  rememberReading,
  scrollTopForAnchor,
  scrollTopForTail,
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
 * knows them. Both are what `placeReading` hands the new list before it paints.
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

  test("the anchor round-trips through the same prefix sum the list paints with", () => {
    const ids = ["a", "b", "c"];
    const heights = new Map([
      ["a", 600],
      ["b", 240],
      ["c", 900],
    ]);
    const offsets = prefixOffsets(ids, heights, ROW_ESTIMATE, ROW_GAP);
    const scrollTop = offsets[1]! + 36;
    const anchor = anchorAt(scrollTop, ids, heights, ROW_ESTIMATE, ROW_GAP);
    expect(anchor).toEqual({ turnId: "b", offset: 36 });
    expect(scrollTopForAnchor(anchor!, ids, heights, ROW_ESTIMATE, ROW_GAP)).toBe(scrollTop);
  });

  test("an anchor can come from offsets the virtual list already has", () => {
    const ids = ["a", "b", "c"];
    const heights = new Map([
      ["a", 600],
      ["b", 240],
      ["c", 900],
    ]);
    const offsets = prefixOffsets(ids, heights, ROW_ESTIMATE, ROW_GAP);
    for (const top of [0, 36, offsets[1]! + 17, offsets[2]! + 23, offsets[3]! + 50]) {
      expect(anchorFromOffsets(top, offsets, (i) => ids[i])).toEqual(
        anchorAt(top, ids, heights, ROW_ESTIMATE, ROW_GAP),
      );
    }
    expect(anchorFromOffsets(0, new Float64Array(1), () => "missing")).toBeUndefined();
  });

  test("a row above the anchor growing does not move the anchor row", () => {
    // This is the jump. The old memory was a pixel. Measuring the row above
    // made that pixel point at a different turn, and the column slid. The
    // anchor stays the same distance into its own row, so the scroll position
    // absorbs the growth and the row the reader is on stays put.
    const ids = ["a", "b", "c"];
    const heights = new Map([
      ["a", 100],
      ["b", 200],
      ["c", 300],
    ]);
    const anchor = { turnId: "c", offset: 12 };
    const before = scrollTopForAnchor(anchor, ids, heights, ROW_ESTIMATE, ROW_GAP)!;
    const taller = new Map(heights);
    taller.set("a", 400);
    const after = scrollTopForAnchor(anchor, ids, taller, ROW_ESTIMATE, ROW_GAP)!;
    expect(after - before).toBe(300);
    const offsets = prefixOffsets(ids, taller, ROW_ESTIMATE, ROW_GAP);
    expect(after - offsets[2]!).toBe(12);
  });

  test("a missing anchor row lands on the tail", () => {
    const ids = ["a", "b"];
    const heights = new Map([
      ["a", 500],
      ["b", 500],
    ]);
    expect(scrollTopForAnchor({ turnId: "gone", offset: 0 }, ids, heights, ROW_ESTIMATE, ROW_GAP)).toBeUndefined();
    expect(scrollTopForTail(ids, heights, ROW_ESTIMATE, ROW_GAP, 200)).toBe(500 + ROW_GAP + 500 + ROW_GAP - 200);
  });

  test("known heights put the tail somewhere the estimate would not", () => {
    const ids = ["a", "b"];
    const heights = new Map([
      ["a", 600],
      ["b", 600],
    ]);
    const real = scrollTopForTail(ids, heights, ROW_ESTIMATE, ROW_GAP, 200);
    const guessed = scrollTopForTail(ids, new Map(), ROW_ESTIMATE, ROW_GAP, 200);
    expect(real).toBe(600 + ROW_GAP + 600 + ROW_GAP - 200);
    expect(guessed).toBe(ROW_ESTIMATE + ROW_GAP + ROW_ESTIMATE + ROW_GAP - 200);
    expect(real).not.toBe(guessed);
  });

  test("an unpinned reading wins over a pixel that says the top", () => {
    const key = "pane-a:place";
    writeRowHeight(key, "a", 800);
    writeRowHeight(key, "b", 800);
    rememberReading(key, { pinned: false, turnId: "b", offset: 40 });
    const placed = placeReading({
      key,
      ids: ["a", "b"],
      viewport: 400,
      fallback: { scrollTop: 0, pinned: true },
    });
    expect(placed.pinned).toBe(false);
    expect(placed.scrollTop).toBe(800 + ROW_GAP + 40);
    expect(recallReading(key)).toEqual({ pinned: false, turnId: "b", offset: 40 });
  });

  test("a pinned reading opens on the tail of the measured list", () => {
    const key = "pane-a:tail";
    writeRowHeight(key, "a", 700);
    writeRowHeight(key, "b", 700);
    rememberReading(key, { pinned: true });
    const placed = placeReading({
      key,
      ids: ["a", "b"],
      viewport: 300,
      fallback: { scrollTop: 10, pinned: false },
    });
    expect(placed.pinned).toBe(true);
    expect(placed.scrollTop).toBe(700 + ROW_GAP + 700 + ROW_GAP - 300);
  });

  test("an unmeasured viewport is not asked where the tail is", () => {
    // The first frame before layout has clientHeight 0. The tail computed from
    // it is "the whole extent of whatever is loaded", which for a session that
    // is opening is a handful of turns of a conversation thousands of pixels
    // tall — so the reader was put 396px into a 274,907px transcript, on its
    // first turn. Being pinned is not a pixel to restore: the list follows the
    // tail itself, and it can only do that if it is told the truth.
    const key = "pane-a:unmeasured";
    writeRowHeight(key, "a", 400);
    rememberReading(key, { pinned: true });
    const placed = placeReading({
      key,
      ids: ["a"],
      viewport: 0,
      fallback: { scrollTop: 0, pinned: true },
    });
    expect(placed).toEqual({ pinned: true, scrollTop: 0 });
  });

  test("a measured viewport still places the tail", () => {
    // The counterpart to the guard above: a viewport that has been measured
    // answers the question, and the tail is a real pixel rather than "follow
    // it yourself". Without this, the guard could quietly swallow every case.
    const placed = placeReading({
      key: "pane-a:measured",
      ids: ["a", "b", "c"],
      viewport: 300,
    });
    expect(placed.pinned).toBe(true);
    expect(placed.scrollTop).toBe(
      ROW_ESTIMATE + ROW_GAP + ROW_ESTIMATE + ROW_GAP + ROW_ESTIMATE + ROW_GAP - 300,
    );
  });

  test("with no reading yet, the pixel fallback is what comes back", () => {
    const placed = placeReading({
      key: "pane-z:fresh",
      ids: ["a"],
      viewport: 100,
      fallback: { scrollTop: 48, pinned: false },
    });
    expect(placed).toEqual({ scrollTop: 48, pinned: false });
  });

  test("a scroll remembers the row, and a pinned one forgets the pixel", () => {
    const key = "pane-a:note";
    writeRowHeight(key, "a", 500);
    expect(readingFromScroll(key, 20, false, ["a", "b"])).toEqual({
      pinned: false,
      turnId: "a",
      offset: 20,
    });
    expect(readingFromScroll(key, 20, true, ["a", "b"])).toEqual({ pinned: true });
  });

  test("both transcripts hand the list the layout they already measured", () => {
    // The math above does nothing if the list that mounts never hears it.
    // Both panes build a list, and a switch mounts the other one, so a seed
    // applied to only one of them leaves the jump on the way back.
    for (const file of ["session-detail.tsx", "peer-transcript.tsx"]) {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      expect(src).toContain("layoutKey={layoutKey(");
      expect(src).toContain("seed={readRowHeights(");
      expect(src).toContain("follow={pinned()}");
      expect(src).toContain("writeRowHeight(key, turnId, height)");
      expect(src).toContain("placeReading({");
      expect(src).toContain("rememberReading(");
      expect(src).toContain("estimate={ROW_ESTIMATE}");
      expect(src).toContain("gap={ROW_GAP}");
    }
    const list = readFileSync(join(import.meta.dir, "virtual.tsx"), "utf8");
    expect(list).toContain("pinScroll");
    expect(list).toContain("props.layoutKey");
    expect(list).toContain("new Map(props.seed)");
  });

  test("pinning refuses a scroller that has no height yet", () => {
    // clientHeight 0 is the frame before layout. Pinning then sets scrollTop
    // to the whole extent, and the next frame — now that the box has a height
    // — pulls it back by exactly that height. The column jumps.
    expect(pinScroll(4000, 0)).toBeUndefined();
    expect(pinScroll(4000, 500)).toBe(3500);
    expect(pinScroll(100, 500)).toBe(0);
  });
});
