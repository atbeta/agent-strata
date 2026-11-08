import { describe, expect, test } from "bun:test";
import { clearProgress, noteProgress, progressLabel, progressOf } from "./plugin-progress";

describe("a plugin tool's progress", () => {
  test("the latest report wins, and a percentage reads as one", () => {
    noteProgress({ call_id: "c1", message: "opening", percent: 10 });
    expect(progressLabel("c1")).toBe("10%");
    noteProgress({ call_id: "c1", message: "halfway", percent: 50 });
    expect(progressLabel("c1")).toBe("50%");
  });

  test("no percentage falls back to the message", () => {
    noteProgress({ call_id: "c2", message: "reading the page" });
    expect(progressLabel("c2")).toBe("reading the page");
    expect(progressOf("c2")?.message).toBe("reading the page");
  });

  test("a call with nothing reported shows nothing", () => {
    // This is what keeps a row that never reports progress looking exactly as
    // it did before the feature existed.
    expect(progressLabel("never")).toBeUndefined();
    expect(progressLabel(undefined)).toBeUndefined();
  });

  test("a settled call drops its progress", () => {
    noteProgress({ call_id: "c3", message: "working", percent: 30 });
    expect(progressLabel("c3")).toBe("30%");
    clearProgress("c3");
    expect(progressLabel("c3")).toBeUndefined();
  });

  test("a report with no call id is ignored", () => {
    // The host falls back to a session-level display for those; the row has
    // nothing to attach it to, so keeping it would be a leak.
    noteProgress({ message: "orphan", percent: 99 });
    expect(progressOf("")).toBeUndefined();
  });
});
