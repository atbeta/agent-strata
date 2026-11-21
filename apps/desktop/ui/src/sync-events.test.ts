import { describe, expect, test } from "bun:test";
import { changesSessionList, pullAllowed } from "./sync-events";

describe("when the background pull may run", () => {
  test("a visible, launched window with no sync in flight pulls", () => {
    expect(pullAllowed({ ready: true, syncing: false, hidden: false })).toBe(true);
  });

  test("a hidden window does not, whatever woke the pull", () => {
    expect(pullAllowed({ ready: true, syncing: false, hidden: true })).toBe(false);
  });

  test("launch and a running sync still hold it back", () => {
    expect(pullAllowed({ ready: false, syncing: false, hidden: false })).toBe(false);
    expect(pullAllowed({ ready: true, syncing: true, hidden: false })).toBe(false);
  });
});

describe("what may move the list during a sync", () => {
  test("a session appearing, leaving, or changing status still gets through", () => {
    for (const type of [
      "session.started",
      "session.deleted",
      "session.status",
      "session.ended",
      "permission.requested",
      "permission.resolved",
      "question.asked",
      "question.resolved",
      "session.error",
    ]) {
      expect(changesSessionList(type)).toBe(true);
    }
  });

  test("imported transcript events do not", () => {
    for (const type of [
      "turn.user",
      "turn.assistant",
      "tool.call",
      "tool.result",
      "file.changed",
      "session.compacted",
    ]) {
      expect(changesSessionList(type)).toBe(false);
    }
  });

  test("metadata waits for the single reread at the finish", () => {
    expect(changesSessionList("session.updated")).toBe(false);
    expect(changesSessionList(undefined)).toBe(false);
  });
});
