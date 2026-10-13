import { describe, expect, test } from "bun:test";
import { mergeUserBar, traceJump, traceMaxOffset, tracePage, traceWindow } from "./trace-window";

describe("trace window", () => {
  test("a strip that fits has nowhere to move", () => {
    expect(traceMaxOffset(400, 800)).toBe(0);
    expect(tracePage(400, 800, 0, 1)).toBe(0);
    expect(traceJump(400, 800, 0.2)).toBe(0);
  });

  test("an unmeasured strip does not move", () => {
    expect(traceMaxOffset(2000, 0)).toBe(0);
  });

  test("paging stays inside the session and a jump centers the window", () => {
    expect(traceMaxOffset(2000, 500)).toBe(1500);
    expect(tracePage(2000, 500, 1500, -1)).toBe(1100);
    expect(tracePage(2000, 500, 0, -1)).toBe(0);
    expect(tracePage(2000, 500, 1400, 1)).toBe(1500);
    expect(traceJump(2000, 500, 0.5)).toBe(750);
    expect(traceJump(2000, 500, 0)).toBe(0);
    expect(traceJump(2000, 500, 1)).toBe(1500);
  });

  test("a re-read of the same prompt stays where it was sent", () => {
    const first = mergeUserBar(undefined, { seq: 518, ts: "2026-09-01T02:32:37.854Z", preview: "清理未引用" });
    const again = mergeUserBar(first, { seq: 1033, ts: "2026-09-01T02:32:37.854Z", preview: "清理未引用" });
    expect(again.seq).toBe(518);
    const fuller = mergeUserBar(
      { seq: 10, ts: "t", preview: "推" },
      { seq: 11, ts: "t2", preview: "推送" },
    );
    expect(fuller).toEqual({ seq: 10, ts: "t", preview: "推送" });
    const earlier = mergeUserBar(
      { seq: 20, ts: "late", preview: "message" },
      { seq: 4, ts: "early", preview: "你好" },
    );
    expect(earlier).toEqual({ seq: 4, ts: "early", preview: "你好" });
  });

  test("a small pan stays in the same mounted range", () => {
    expect(traceWindow(0, 500)).toEqual({ start: 0, end: 820 });
    expect(traceWindow(319, 500)).toEqual({ start: 0, end: 820 });
    expect(traceWindow(320, 500)).toEqual({ start: 0, end: 1140 });
    expect(traceWindow(1500, 500)).toEqual({ start: 960, end: 2100 });
  });
});
