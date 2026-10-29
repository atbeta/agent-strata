import { describe, expect, test } from "bun:test";
import { joinQueued, readQueuedText, takeQueuedText, writeQueuedText } from "./prompt-memory";

/** The map-backed store the other suites use. */
function store(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    raw: map,
  };
}

describe("a queue that outlives the window", () => {
  test("the words are kept, so they can come back in the draft", () => {
    const s = store();
    writeQueuedText("s1", ["first", "second"], s);
    expect(readQueuedText("s1", s)).toEqual(["first", "second"]);
  });

  test("an empty queue leaves nothing behind", () => {
    const s = store();
    writeQueuedText("s1", ["only"], s);
    writeQueuedText("s1", [], s);
    expect(readQueuedText("s1", s)).toEqual([]);
    expect(s.raw.size).toBe(0);
  });

  test("blank entries are not worth keeping", () => {
    const s = store();
    writeQueuedText("s1", ["kept", "   ", ""], s);
    expect(readQueuedText("s1", s)).toEqual(["kept"]);
  });

  test("sessions do not read each other's queues", () => {
    const s = store();
    writeQueuedText("s1", ["mine"], s);
    writeQueuedText("s2", ["theirs"], s);
    expect(readQueuedText("s1", s)).toEqual(["mine"]);
    expect(readQueuedText("s2", s)).toEqual(["theirs"]);
  });

  test("taking clears, so the next open does not fold it in twice", () => {
    // The queue is read-and-clear rather than read: what comes back is about to
    // be shown in the draft, and leaving it in storage would append it again on
    // every open.
    const s = store();
    writeQueuedText("s1", ["once"], s);
    expect(takeQueuedText("s1", s as never)).toEqual(["once"]);
    expect(readQueuedText("s1", s)).toEqual([]);
  });

  test("a storage that refuses to write is not an error", () => {
    // Private mode, or a quota that will not take it: the queue still works for
    // this run, it just will not come back after a restart.
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
    };
    expect(() => writeQueuedText("s1", ["x"], refusing)).not.toThrow();
    expect(readQueuedText("s1", refusing)).toEqual([]);
  });

  test("malformed storage reads as no queue", () => {
    expect(readQueuedText("s1", store({ "strata.queued.s1": "{" }))).toEqual([]);
    expect(readQueuedText("s1", store({ "strata.queued.s1": '{"a":1}' }))).toEqual([]);
    expect(readQueuedText("s1", store({ "strata.queued.s1": '[1,"ok",null]' }))).toEqual(["ok"]);
  });
});

describe("folding a queue back into the draft", () => {
  test("waiting messages go above what was typed", () => {
    expect(joinQueued("typed now", ["queued then"])).toBe("typed now\nqueued then");
  });

  test("an empty draft is just the waiting messages", () => {
    expect(joinQueued("", ["a", "b"])).toBe("a\nb");
  });

  test("nothing waiting leaves the draft alone", () => {
    expect(joinQueued("typed", [])).toBe("typed");
    expect(joinQueued("typed", ["  ", ""])).toBe("typed");
  });

  test("a whitespace-only draft does not leave a leading blank line", () => {
    expect(joinQueued("   ", ["a"])).toBe("a");
  });
});
