import { describe, expect, test } from "bun:test";
import {
  changesSessionList,
  PULL_EVERY_MS,
  PULL_ON_RETURN_MS,
  PULL_TICK_MS,
  pullAllowed,
  pullDue,
  staleSyncTicks,
} from "./sync-events";

describe("when the background pull may run", () => {
  test("a visible, launched window with no sync in flight pulls", () => {
    expect(pullAllowed({ ready: true, syncing: false, hidden: false })).toBe(true);
  });

  test("a hidden window does not, unless the reader asked", () => {
    expect(pullAllowed({ ready: true, syncing: false, hidden: true })).toBe(false);
    expect(pullAllowed({ ready: true, syncing: false, hidden: true, manual: true })).toBe(true);
  });

  test("launch and a running sync still hold it back, a click included", () => {
    for (const manual of [false, true]) {
      expect(pullAllowed({ ready: false, syncing: false, hidden: false, manual })).toBe(false);
      expect(pullAllowed({ ready: true, syncing: true, hidden: false, manual })).toBe(false);
    }
  });
});

describe("when a pull is due", () => {
  const due = (reason: "timer" | "return" | "manual", sinceLast: number | undefined, connected = true) =>
    pullDue({ reason, connected, sinceLast });

  test("the first pull is always due", () => {
    expect(due("timer", undefined)).toBe(true);
    expect(due("return", undefined)).toBe(true);
  });

  test("with a backend connected, the timer waits out the slow pace", () => {
    expect(due("timer", PULL_TICK_MS)).toBe(false);
    expect(due("timer", PULL_EVERY_MS - 1)).toBe(false);
    expect(due("timer", PULL_EVERY_MS)).toBe(true);
  });

  test("coming back to the window pulls only after a while", () => {
    expect(due("return", 1_000)).toBe(false);
    expect(due("return", PULL_ON_RETURN_MS - 1)).toBe(false);
    expect(due("return", PULL_ON_RETURN_MS)).toBe(true);
  });

  test("the reader's own ask is always due", () => {
    expect(due("manual", 0)).toBe(true);
  });

  test("with nothing connected the pull is the reconnect, so every tick pulls", () => {
    expect(due("timer", PULL_TICK_MS, false)).toBe(true);
    expect(due("return", 1_000, false)).toBe(true);
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
