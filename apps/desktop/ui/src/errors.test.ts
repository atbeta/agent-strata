import { describe, expect, test } from "bun:test";
import { fadeKeyed, fadeSignal } from "./errors";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("fadeSignal", () => {
  test("a message fades on its own; the empty value clears at once", async () => {
    const [err, setErr] = fadeSignal("", 20);
    setErr("nope");
    expect(err()).toBe("nope");
    setErr("");
    expect(err()).toBe("");
    setErr("again");
    await sleep(40);
    expect(err()).toBe("");
  });

  test("a new message resets the clock instead of dying under the old one", async () => {
    const [err, setErr] = fadeSignal("", 40);
    setErr("first");
    await sleep(25);
    setErr("second");
    await sleep(25);
    // 50ms in — the first timer would have fired; the second message is still fresh
    expect(err()).toBe("second");
    await sleep(25);
    expect(err()).toBe("");
  });
});

describe("fadeKeyed", () => {
  test("each key fades on its own clock; empty text clears it", async () => {
    const [errs, setErr] = fadeKeyed(25);
    setErr("a", "one");
    setErr("b", "two");
    expect(errs()).toEqual({ a: "one", b: "two" });
    setErr("a", "");
    expect(errs()).toEqual({ b: "two" });
    await sleep(45);
    expect(errs()).toEqual({});
  });
});
