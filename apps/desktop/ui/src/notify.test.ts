import { describe, expect, test } from "bun:test";
import {
  finishedSessions,
  readNotify,
  rememberWaiting,
  saveNotify,
  waitingSessions,
} from "./notify";

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

describe("a preference saved before the kinds split", () => {
  const storage = (entries: Record<string, string> = {}) => {
    const map = new Map(Object.entries(entries));
    return {
      map,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    };
  };

  test("seeds both kinds from the shared key, then drops it", () => {
    const s = storage({ "strata.notify": "1" });
    expect(readNotify("done", s)).toBe(true);
    expect(readNotify("question", s)).toBe(true);
    expect(s.map.has("strata.notify")).toBe(false);
  });

  test("turning one kind off keeps the other on the legacy value", () => {
    const s = storage({ "strata.notify": "1" });
    saveNotify("done", false, s);
    expect(readNotify("done", s)).toBe(false);
    expect(readNotify("question", s)).toBe(true);
  });

  test("a shared off seeds both kinds off", () => {
    const s = storage({ "strata.notify": "0" });
    expect(readNotify("done", s)).toBe(false);
    expect(readNotify("question", s)).toBe(false);
  });

  test("a kind saved since the split wins over the shared key", () => {
    const s = storage({ "strata.notify": "1", "strata.notify.question": "0" });
    expect(readNotify("done", s)).toBe(true);
    expect(readNotify("question", s)).toBe(false);
  });

  test("defaults to off when nothing was ever saved", () => {
    const s = storage();
    expect(readNotify("done", s)).toBe(false);
    saveNotify("question", true, s);
    expect(readNotify("question", s)).toBe(true);
  });
});
