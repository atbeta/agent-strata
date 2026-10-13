import { describe, expect, test } from "bun:test";
import { holdRows, sameValue } from "./session-rows";

describe("value equality", () => {
  test("separates equal-looking copies from equal values", () => {
    expect(sameValue({ a: 1 }, { a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameValue([1, [2, { a: 3 }]], [1, [2, { a: 3 }]])).toBe(true);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
  });

  test("counts the keys, so a dropped or added field is a difference", () => {
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  test("does not call an array and an object with the same keys equal", () => {
    expect(sameValue({ 0: "a", length: 1 }, ["a"])).toBe(false);
  });

  test("handles the awkward ones", () => {
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(null, {})).toBe(false);
    expect(sameValue(undefined, undefined)).toBe(true);
    expect(sameValue(NaN, NaN)).toBe(false);
    expect(sameValue("a", "a")).toBe(true);
  });
});

describe("holding rows still", () => {
  const row = (id: string, title: string) => ({ id, title });
  const byId = (r: { id: string }) => r.id;
  const same = (a: { id: string; title: string }, b: { id: string; title: string }) => sameValue(a, b);

  test("with nothing to compare against, everything is new", () => {
    const next = [row("a", "A")];
    const out = holdRows(next, undefined, byId, same);
    expect(out).toEqual(next);
    expect(out[0]).toBe(next[0]);
  });

  test("an unchanged row is the same object, not a copy", () => {
    const before = [row("a", "A"), row("b", "B")];
    const after = [row("a", "A"), row("b", "B")];
    const out = holdRows(after, before, byId, same);
    expect(out[0]).toBe(before[0]);
    expect(out[1]).toBe(before[1]);
  });

  test("a row whose content moved on is not held", () => {
    const before = [row("a", "A")];
    const after = [row("a", "renamed")];
    expect(holdRows(after, before, byId, same)[0]).not.toBe(before[0]);
  });

  test("a row that vanished, and one that arrived", () => {
    const before = [row("a", "A"), row("b", "B")];
    const after = [row("b", "B"), row("c", "C")];
    const out = holdRows(after, before, byId, same);
    expect(out.map(byId)).toEqual(["b", "c"]);
    expect(out[0]).toBe(before[1]);
    expect(out[1]).not.toBe(before[0]);
  });

  test("order follows the new list even though identity does not", () => {
    const before = [row("a", "A"), row("b", "B"), row("c", "C")];
    const after = [row("c", "C"), row("a", "A")];
    const out = holdRows(after, before, byId, same);
    expect(out.map(byId)).toEqual(["c", "a"]);
    expect(out[0]).toBe(before[2]);
    expect(out[1]).toBe(before[0]);
  });

  test("a row repeated in the new list does not collapse into one", () => {
    const before = [row("a", "A")];
    const out = holdRows([row("a", "A"), row("a", "A")], before, byId, same);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(before[0]);
    expect(out[1]).toBe(before[0]);
  });
});
