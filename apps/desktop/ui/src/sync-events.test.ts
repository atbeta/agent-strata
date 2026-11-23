import { describe, expect, test } from "bun:test";
import { changesSessionList, pullAllowed, staleSyncTicks } from "./sync-events";

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

describe("the ticks the service no longer backs", () => {
  const ticks = (...ids: string[]) => new Map(ids.map((id) => [id, { done: 0, total: 0 }]));

  test("a connection the service calls idle has no sync behind it", () => {
    expect(
      staleSyncTicks(ticks("a", "b"), [
        { id: "a", sync: "idle" },
        { id: "b", sync: "syncing" },
      ]),
    ).toEqual(["a"]);
  });

  test("a connection the service no longer lists is gone with its tick", () => {
    expect(staleSyncTicks(ticks("a"), [{ id: "b", sync: "syncing" }])).toEqual(["a"]);
  });

  test("a sync that is starting or running keeps its tick", () => {
    expect(
      staleSyncTicks(ticks("a", "b"), [
        { id: "a", sync: "starting" },
        { id: "b", sync: "syncing" },
      ]),
    ).toEqual([]);
  });

  test("a connection whose state is unknown is left alone", () => {
    // The service always answers with one of the three, but a tick held for
    // good is a milder fault than a live one cleared early.
    expect(staleSyncTicks(ticks("a"), [{ id: "a" }])).toEqual([]);
  });

  test("no ticks, nothing to reconcile", () => {
    expect(staleSyncTicks(new Map(), [{ id: "a", sync: "idle" }])).toEqual([]);
  });
});
