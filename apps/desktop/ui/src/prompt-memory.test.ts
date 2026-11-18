import { describe, expect, test } from "bun:test";
import {
  createDraftWriter,
  flushDrafts,
  navigateHistory,
  readDraft,
  rememberPrompt,
  scheduleDraft,
  sessionContext,
} from "./prompt-memory";

const usage = (
  input: number,
  extra: { output?: number; cache_read?: number; cache_write?: number; reasoning?: number } = {},
) => ({
  input,
  output: extra.output ?? 0,
  cache_read: extra.cache_read,
  cache_write: extra.cache_write,
  reasoning: extra.reasoning,
});

describe("sessionContext", () => {
  test("uses the latest assistant message that actually spent tokens", () => {
    const ctx = sessionContext(
      [
        { assistant: [{ usage: usage(100, { output: 20 }) }] },
        { assistant: [{ usage: usage(0) }, { usage: usage(800, { output: 40, cache_read: 10 }) }] },
      ],
      1_000,
      "opencode",
    );
    expect(ctx).toEqual({
      total: 810,
      percent: 81,
      limit: 1_000,
      usage: { input: 800, cache_read: 10, cache_write: 0, output: 40, reasoning: 0 },
    });
  });

  test("percent and limit stay unset when the model publishes no window", () => {
    expect(
      sessionContext([{ assistant: [{ usage: usage(10, { output: 5 }) }] }], undefined, "opencode"),
    ).toEqual({
      total: 10,
      percent: null,
      limit: null,
      usage: { input: 10, cache_read: 0, cache_write: 0, output: 5, reasoning: 0 },
    });
  });

  test("the reply is not part of the context it leaves behind", () => {
    // Output and reasoning are generated; the next turn's window does not hold
    // them. Counting them reported a window fuller than it was.
    const ctx = sessionContext(
      [{ assistant: [{ usage: usage(100, { output: 900, reasoning: 500 }) }] }],
      1_000,
      "opencode",
    );
    expect(ctx?.total).toBe(100);
    expect(ctx?.percent).toBe(10);
  });

  test("a non-OpenCode backend's aggregate usage is not a request", () => {
    const turns = [{ assistant: [{ usage: usage(10, { output: 5 }) }] }];
    expect(sessionContext(turns, 1_000, "acp")).toBeUndefined();
    expect(sessionContext(turns, 1_000, undefined)).toBeUndefined();
  });

  test("an empty transcript has no context", () => {
    expect(sessionContext([], 1_000, "opencode")).toBeUndefined();
  });
});

describe("prompt history", () => {
  test("arrow up from an empty box walks newest first and down restores the draft", () => {
    const entries = rememberPrompt(rememberPrompt([], "older"), "newer");
    const up = navigateHistory({
      direction: "up",
      text: "",
      cursor: 0,
      index: -1,
      entries,
      saved: "",
    });
    expect(up).toMatchObject({ handled: true, index: 0, text: "newer", cursor: "start" });
    const older = navigateHistory({
      direction: "up",
      text: up.text,
      cursor: 0,
      index: up.index,
      entries,
      saved: "kept",
    });
    expect(older).toMatchObject({ handled: true, index: 1, text: "older" });
    const back = navigateHistory({
      direction: "down",
      text: older.text,
      cursor: older.text.length,
      index: older.index,
      entries,
      saved: "kept",
    });
    expect(back).toMatchObject({ index: 0, text: "newer" });
    const restored = navigateHistory({
      direction: "down",
      text: back.text,
      cursor: back.text.length,
      index: back.index,
      entries,
      saved: "kept",
    });
    expect(restored).toMatchObject({ handled: true, index: -1, text: "kept", cursor: "end" });
  });

  test("a typed message keeps the arrow keys", () => {
    const stayed = navigateHistory({
      direction: "up",
      text: "hello",
      cursor: 0,
      index: -1,
      entries: ["older"],
      saved: "",
    });
    expect(stayed.handled).toBe(false);
    expect(stayed.text).toBe("hello");
  });

  test("remembering moves a repeat to the front and caps the list", () => {
    expect(rememberPrompt(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(rememberPrompt(["a", "b", "c"], "d", 2)).toEqual(["d", "a"]);
  });
});

describe("createDraftWriter", () => {
  const rig = () => {
    const writes: [string, string][] = [];
    const timers: (() => void)[] = [];
    const writer = createDraftWriter({
      write: (id, text) => writes.push([id, text]),
      setTimeout: (fn) => {
        timers.push(fn);
        return fn;
      },
      clearTimeout: (t) => {
        const i = timers.indexOf(t as () => void);
        if (i >= 0) timers.splice(i, 1);
      },
    });
    const fire = () => {
      for (const f of timers.splice(0)) f();
    };
    return { writes, writer, fire };
  };

  test("writes are deferred and the newest text wins", () => {
    const { writes, writer, fire } = rig();
    writer.schedule("a", "one");
    writer.schedule("a", "two");
    expect(writes).toEqual([]);
    fire();
    expect(writes).toEqual([["a", "two"]]);
    writer.schedule("a", "three");
    fire();
    expect(writes).toEqual([["a", "two"], ["a", "three"]]);
  });

  test("a clear lands at once and drops what was queued", () => {
    const { writes, writer, fire } = rig();
    writer.schedule("a", "draft");
    writer.schedule("a", "");
    expect(writes).toEqual([["a", ""]]);
    fire();
    expect(writes).toHaveLength(1);
  });

  test("a switch writes the old session before queuing the new one", () => {
    const { writes, writer, fire } = rig();
    writer.schedule("a", "old words");
    writer.schedule("b", "new words");
    expect(writes).toEqual([["a", "old words"]]);
    fire();
    expect(writes).toEqual([["a", "old words"], ["b", "new words"]]);
  });

  test("flush writes the queue now; pendingText sees it first", () => {
    const { writes, writer } = rig();
    writer.schedule("a", "typed");
    expect(writer.pendingText("a")).toBe("typed");
    expect(writer.pendingText("b")).toBeUndefined();
    writer.flush();
    expect(writes).toEqual([["a", "typed"]]);
    expect(writer.pendingText("a")).toBeUndefined();
    writer.flush();
    expect(writes).toHaveLength(1);
  });
});

describe("the shared draft writer", () => {
  test("readDraft sees text still queued behind the throttle", () => {
    scheduleDraft("shared-x", "half a thought");
    expect(readDraft("shared-x")).toBe("half a thought");
    expect(readDraft("other")).toBe("");
    flushDrafts();
    expect(readDraft("shared-x")).toBe("");
  });
});
