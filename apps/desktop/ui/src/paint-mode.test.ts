import { describe, expect, test } from "bun:test";
import { createPaintHold } from "./paint-mode";

describe("a row's paint holds", () => {
  test("settled fires once, when the last hold releases", () => {
    let settled = 0;
    const { hold, pending } = createPaintHold(() => settled++);
    const r1 = hold();
    const r2 = hold();
    expect(pending()).toBe(2);
    r1();
    expect(pending()).toBe(1);
    expect(settled).toBe(0);
    r2();
    expect(pending()).toBe(0);
    expect(settled).toBe(1);
  });

  test("a token released twice is ignored", () => {
    let settled = 0;
    const { hold, pending } = createPaintHold(() => settled++);
    const r = hold();
    r();
    r();
    expect(pending()).toBe(0);
    expect(settled).toBe(1);
    // A fresh hold after settling starts a new count.
    const r2 = hold();
    expect(pending()).toBe(1);
    r2();
    expect(settled).toBe(2);
  });
});
