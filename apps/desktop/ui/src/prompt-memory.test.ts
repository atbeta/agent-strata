import { describe, expect, test } from "bun:test";
import { navigateHistory, rememberPrompt, sessionContext } from "./prompt-memory";

const usage = (input: number, extra: { output?: number; cache_read?: number } = {}) => ({
  input,
  output: extra.output ?? 0,
  cache_read: extra.cache_read,
});

describe("sessionContext", () => {
  test("uses the latest assistant message that actually spent tokens", () => {
    const ctx = sessionContext(
      [
        { assistant: [{ usage: usage(100, { output: 20 }) }] },
        { assistant: [{ usage: usage(0) }, { usage: usage(800, { output: 40, cache_read: 10 }) }] },
      ],
      1_000,
    );
    expect(ctx).toEqual({ total: 850, percent: 85 });
  });

  test("percent stays unset when the model publishes no window", () => {
    expect(sessionContext([{ assistant: [{ usage: usage(10, { output: 5 }) }] }])).toEqual({
      total: 15,
      percent: null,
    });
  });

  test("an empty transcript has no context", () => {
    expect(sessionContext([])).toBeUndefined();
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
