import { describe, expect, test } from "bun:test";
import { isClamp, readingAt, targetScrollTop } from "./scroll-owner";
import { JUMP_GAP, TAIL_TOLERANCE } from "./virtual-tail";

// A three-row list under a padded column: origin 40, rows of 200, 300, 400
// with a 10px gap — offsets [0, 210, 520, 930] — inside a 1000px viewport.
const ids = ["t0", "t1", "t2"];
const offsets = new Float64Array([0, 210, 520, 930]);
const indexOf = (id: string) => ids.indexOf(id);

describe("readingAt", () => {
  test("the tail counts everything within the tolerance, including past it", () => {
    const base = { clientHeight: 400, origin: 40, offsets, ids };
    expect(readingAt({ ...base, scrollTop: 1000, scrollHeight: 1400 })).toEqual({ pinned: true });
    expect(
      readingAt({ ...base, scrollTop: 1400 - 400 - TAIL_TOLERANCE + 1, scrollHeight: 1400 }),
    ).toEqual({ pinned: true });
    // One pixel short of the tolerance is a reader who scrolled up.
    expect(
      readingAt({ ...base, scrollTop: 1400 - 400 - TAIL_TOLERANCE - 1, scrollHeight: 1400 }),
    ).not.toEqual({ pinned: true });
  });

  test("the reading is the row under the viewport's top edge and the offset into it", () => {
    const r = readingAt({
      scrollTop: 40 + 520 + 37, // 37px into row t2
      clientHeight: 400,
      scrollHeight: 1400,
      origin: 40,
      offsets,
      ids,
    });
    expect(r).toEqual({ pinned: false, turnId: "t2", offset: 37 });
  });

  test("a top edge above the list anchors on the first row with a negative offset", () => {
    const r = readingAt({
      scrollTop: 10,
      clientHeight: 400,
      scrollHeight: 1400,
      origin: 40,
      offsets,
      ids,
    });
    expect(r).toEqual({ pinned: false, turnId: "t0", offset: -30 });
  });
});

describe("targetScrollTop", () => {
  test("pinned targets the end of the content", () => {
    expect(
      targetScrollTop({
        reading: { pinned: true }, origin: 40, offsets, indexOf,
        scrollHeight: 1400, clientHeight: 400,
      }),
    ).toBe(1000);
  });

  test("a pinned target is refused before the scroller has a height", () => {
    expect(
      targetScrollTop({
        reading: { pinned: true }, origin: 40, offsets, indexOf,
        scrollHeight: 1400, clientHeight: 0,
      }),
    ).toBeUndefined();
  });

  test("an anchored row that grew nothing moves nothing; a row above it growing moves everything", () => {
    const reading = { pinned: false as const, turnId: "t2", offset: 37 };
    const before = targetScrollTop({
      reading, origin: 40, offsets, indexOf, scrollHeight: 1400, clientHeight: 400,
    });
    // Row t0 grows 100 → t2's offset shifts by 100, and the target shifts with
    // it, holding the row where the reader left it.
    const grown = new Float64Array([0, 310, 620, 1030]);
    const after = targetScrollTop({
      reading, origin: 40, offsets: grown, indexOf, scrollHeight: 1500, clientHeight: 400,
    });
    expect(after! - before!).toBe(100);
    expect(after).toBe(40 + 620 + 37);
  });

  test("an anchored row that is absent has no position to write", () => {
    expect(
      targetScrollTop({
        reading: { pinned: false, turnId: "t99", offset: 0 }, origin: 40, offsets, indexOf,
        scrollHeight: 1400, clientHeight: 400,
      }),
    ).toBeUndefined();
  });

  test("a jump lands the row JUMP_GAP below the viewport's top edge", () => {
    const jump = { pinned: false as const, turnId: "t1", offset: -JUMP_GAP };
    expect(
      targetScrollTop({
        reading: jump, origin: 40, offsets, indexOf,
        scrollHeight: 1400, clientHeight: 400,
      }),
    ).toBe(40 + 210 - JUMP_GAP);
  });
});

describe("isClamp", () => {
  test("a position pulled back to the end of shrunken content is a clamp", () => {
    // The fixture case: a held row's empty height was committed, the host lost
    // 7,514px, and the browser pulled scrollTop from 20,757 down to the new
    // maximum. At the very bottom and below the last write — a clamp.
    expect(
      isClamp({ scrollTop: 17083, scrollHeight: 17775, clientHeight: 692, lastWritten: 20757 }),
    ).toBe(true);
  });

  test("a reader who scrolled to the bottom is not a clamp", () => {
    // lastWritten is *below* scrollTop — the reader moved down, not the
    // content under them.
    expect(
      isClamp({ scrollTop: 17083, scrollHeight: 17775, clientHeight: 692, lastWritten: 16000 }),
    ).toBe(false);
  });

  test("a mid-list move is not a clamp", () => {
    expect(
      isClamp({ scrollTop: 5000, scrollHeight: 17775, clientHeight: 692, lastWritten: 20757 }),
    ).toBe(false);
  });

  test("nothing written yet cannot be a clamp", () => {
    expect(
      isClamp({ scrollTop: 0, scrollHeight: 17775, clientHeight: 692, lastWritten: undefined }),
    ).toBe(false);
  });
});
