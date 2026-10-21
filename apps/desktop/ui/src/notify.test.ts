import { describe, expect, test } from "bun:test";
import { finishedSessions, rememberWaiting, waitingSessions } from "./notify";

describe("a session that just finished", () => {
  test("notices a session that was busy and is now idle", () => {
    const prev = new Map([
      ["a", true],
      ["b", false],
    ]);
    expect(
      finishedSessions(prev, [
        { id: "a", title: "one", busy: false },
        { id: "b", title: "two", busy: false },
        { id: "c", title: "three", busy: false },
      ]).map((row) => row.id),
    ).toEqual(["a"]);
  });

  test("stays quiet while a session is still running", () => {
    expect(finishedSessions(new Map([["a", true]]), [{ id: "a", title: "one", busy: true }])).toEqual([]);
  });
});

describe("a session that just started waiting", () => {
  test("notices the transition into needs-input, not the state itself", () => {
    const prev = new Map([
      ["a", false],
      ["b", true],
    ]);
    expect(
      waitingSessions(prev, [
        { id: "a", title: "one", busy: false, needsInput: true },
        { id: "b", title: "two", busy: false, needsInput: true },
        { id: "c", title: "three", busy: false, needsInput: false },
      ]).map((row) => row.id),
    ).toEqual(["a"]);
  });

  test("remembers the waiting state so one request is announced once", () => {
    const seen = new Map<string, boolean>();
    const waiting = { id: "a", title: "one", busy: false, needsInput: true };
    const idle = { ...waiting, needsInput: false };
    rememberWaiting(seen, [idle]);
    expect(waitingSessions(seen, [waiting]).map((row) => row.id)).toEqual(["a"]);
    rememberWaiting(seen, [waiting]);
    expect(waitingSessions(seen, [waiting])).toEqual([]);
    expect(waitingSessions(seen, [idle])).toEqual([]);
    rememberWaiting(seen, [idle]);
    expect(waitingSessions(seen, [waiting]).map((row) => row.id)).toEqual(["a"]);
  });
});
