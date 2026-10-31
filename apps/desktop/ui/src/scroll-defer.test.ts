import { describe, expect, test } from "bun:test";
import { createScrollDeferral, deferTranscriptWrite } from "./scroll-defer";

describe("deferTranscriptWrite", () => {
  test("a scroll through history holds writes", () => {
    expect(deferTranscriptWrite(true, false)).toBe(true);
  });

  test("the tail the reader is watching keeps painting", () => {
    expect(deferTranscriptWrite(true, true)).toBe(false);
    expect(deferTranscriptWrite(false, false)).toBe(false);
  });
});

describe("createScrollDeferral", () => {
  test("the latest snapshot replaces the one held before it", () => {
    const held = createScrollDeferral();
    held.noteSnap({ turn_id: "t", msg_id: "m", content: [{ type: "text", text: "a" }] });
    held.noteSnap({ turn_id: "t", msg_id: "m", content: [{ type: "text", text: "ab" }] });
    expect(held.take().snap?.content).toEqual([{ type: "text", text: "ab" }]);
    expect(held.pending()).toBe(false);
  });

  test("a full refresh stays full when a later event only moves the tail", () => {
    const held = createScrollDeferral();
    held.noteRefresh(true);
    held.noteRefresh(false);
    expect(held.take().refresh).toBe("full");
  });

  test("a tail refresh is what a head probe leaves behind", () => {
    const held = createScrollDeferral();
    held.noteRefresh(false);
    expect(held.take().refresh).toBe("tail");
  });
});
