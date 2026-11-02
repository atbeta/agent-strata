import { describe, expect, test } from "bun:test";
import { samePrefixCount } from "./md-reconcile";

/**
 * A streaming reply is re-parsed on every token. What keeps it from blinking is
 * that the nodes before the change are recognised as unchanged and left alone,
 * so this count is the whole mechanism: too low and the reply is rebuilt every
 * frame, too high and stale nodes stay on screen.
 */

const eq = (a: string, b: string) => a === b;

describe("unchanged prefix of a rebuilt tail", () => {
  test("a paragraph that grew keeps every node before the change", () => {
    const before = ["<p>第一段</p>", "<p>第二段写到一半</p>"];
    const after = ["<p>第一段</p>", "<p>第二段写到一半了</p>"];
    expect(samePrefixCount(before, after, eq)).toBe(1);
  });

  test("an appended block keeps all of the nodes already painted", () => {
    const before = ["<p>一</p>", "<p>二</p>"];
    const after = ["<p>一</p>", "<p>二</p>", "<p>三</p>"];
    expect(samePrefixCount(before, after, eq)).toBe(2);
  });

  test("an unchanged tail is entirely kept, so nothing is repainted", () => {
    const same = ["<p>一</p>", "<p>二</p>"];
    expect(samePrefixCount(same, [...same], eq)).toBe(2);
  });

  test("a change in the first node keeps nothing before it", () => {
    expect(samePrefixCount(["<p>a</p>", "<p>b</p>"], ["<p>z</p>", "<p>b</p>"], eq)).toBe(0);
  });

  test("an emptied tail keeps nothing, so the old nodes are dropped", () => {
    expect(samePrefixCount(["<p>一</p>"], [], eq)).toBe(0);
  });

  test("a first tail keeps nothing", () => {
    expect(samePrefixCount([], ["<p>一</p>"], eq)).toBe(0);
  });

  test("a shorter tail keeps only the part that still matches", () => {
    expect(samePrefixCount(["<p>一</p>", "<p>二</p>"], ["<p>一</p>"], eq)).toBe(1);
  });

  test("the walk stops at the first difference, not at the last", () => {
    let calls = 0;
    const counted = (a: string, b: string) => {
      calls += 1;
      return a === b;
    };
    const before = ["a", "b", "c", "d"];
    const after = ["a", "b", "X", "d"];
    expect(samePrefixCount(before, after, counted)).toBe(2);
    // Three comparisons for four nodes: the mismatch ends the walk, and `d`
    // after it is never looked at.
    expect(calls).toBe(3);
  });
});
