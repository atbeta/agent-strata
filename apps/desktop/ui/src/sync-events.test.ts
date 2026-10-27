import { describe, expect, test } from "bun:test";
import { changesSessionList } from "./sync-events";

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
