import { describe, expect, test } from "bun:test";
import { stableBoundary } from "./md-stream";

describe("a streaming markdown cut", () => {
  test("prose with no fence has nothing to keep", () => {
    expect(stableBoundary("hello\n\nworld")).toBe(0);
  });

  test("an unclosed fence at the start is still the tail", () => {
    expect(stableBoundary("```ts\nconst x = 1")).toBe(0);
  });

  test("prose before an unclosed fence is finished", () => {
    const src = "hello\n\n```ts\nconst x = 1";
    expect(stableBoundary(src)).toBe(src.indexOf("```"));
  });

  test("a closed fence, and only that fence, leaves the tail", () => {
    const src = "hello\n\n```ts\nconst x = 1\n```\n\nmore";
    const cut = src.indexOf("```\n\nmore") + "```\n".length;
    expect(stableBoundary(src)).toBe(cut);
    expect(src.slice(cut)).toBe("\nmore");
  });

  test("a second closed fence pulls the prose between them in", () => {
    const src = "```js\nconst a = 1\n```\n\nbetween\n\n```py\nprint(1)\n```\n\nout";
    const cut = src.indexOf("```\n\nout") + "```\n".length;
    expect(stableBoundary(src)).toBe(cut);
    expect(src.slice(0, cut)).toContain("between");
    expect(src.slice(cut)).toBe("\nout");
  });

  test("an unclosed second fence keeps the first fence and the prose before the opener", () => {
    const src = "```js\nconst a = 1\n```\n\nbetween\n\n```py\nprint(";
    expect(stableBoundary(src)).toBe(src.lastIndexOf("```"));
  });

  test("a tilde fence is not closed by backticks", () => {
    const src = "~~~\ncode\n```\n";
    expect(stableBoundary(src)).toBe(0);
  });

  test("a shorter run of backticks does not close a longer fence", () => {
    const src = "````js\nconst x = 1\n```\n";
    expect(stableBoundary(src)).toBe(0);
  });

  test("a backtick inside the info string is not an opener", () => {
    expect(stableBoundary("```js`nope\ncode stays prose")).toBe(0);
  });

  test("a bogus opener does not hide a real fence after it", () => {
    const src = "```js`nope\n\n```ts\nconst x = 1\n```\n\nafter";
    const cut = src.indexOf("```\n\nafter") + "```\n".length;
    expect(stableBoundary(src)).toBe(cut);
    expect(src.slice(0, cut)).toContain("```js`nope");
  });

  test("an indented fence stays with the list it belongs to", () => {
    const src = "- item\n\n  ```js\n  code\n  ```\n";
    expect(stableBoundary(src)).toBe(0);
  });

  test("a fence mentioned mid-line is not a fence", () => {
    expect(stableBoundary("see ```js in the text, not a fence")).toBe(0);
  });

  test("a growing reply never moves the cut backward", () => {
    const full = "para\n\n```ts\nconst x = 1\n```\n\nmore\n\n```py\nprint(1)\n```\n\nout\n";
    let prev = 0;
    let prevStable = "";
    for (let n = 0; n <= full.length; n += 1) {
      const slice = full.slice(0, n);
      const cut = stableBoundary(slice);
      const stable = slice.slice(0, cut);
      expect(cut).toBeGreaterThanOrEqual(prev);
      expect(stable.startsWith(prevStable)).toBe(true);
      prev = cut;
      prevStable = stable;
    }
    expect(prevStable.endsWith("```\n")).toBe(true);
    expect(full.slice(prev)).toBe("\nout\n");
  });
});
