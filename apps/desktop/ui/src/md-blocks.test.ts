import { describe, expect, test } from "bun:test";
import { splitBlocks } from "./md-blocks";

describe("splitBlocks", () => {
  test("an empty message has no blocks", () => {
    expect(splitBlocks("")).toEqual([]);
  });

  test("prose is cut at paragraphs, and a growing paragraph leaves the ones before it alone", () => {
    expect(splitBlocks("这是第一段。\n\n这是第二")).toEqual(["这是第一段。", "这是第二"]);
    expect(splitBlocks("这是第一段。\n\n这是第二段")[0]).toBe("这是第一段。");
  });

  test("a fence still being written is the last block", () => {
    expect(splitBlocks("Para\n\n```ts\nconst a")).toEqual(["Para", "```ts\nconst a"]);
  });

  test("a closed fence, a list and a setext heading are blocks of their own", () => {
    const blocks = splitBlocks("Para\n\n```ts\nconst a = 1\n```\n\n- a\n- b\n\nTitle\n===\n");
    expect(blocks).toHaveLength(4);
    expect(blocks[1]).toBe("```ts\nconst a = 1\n```");
    expect(blocks[3]).toBe("Title\n===\n");
  });

  test("reference definitions travel with every block, so a block parsed alone still links", () => {
    expect(splitBlocks("see [x][r]\n\n[r]: http://e.com\n\nnext")).toEqual([
      "see [x][r]\n\n[r]: http://e.com",
      "next\n\n[r]: http://e.com",
    ]);
  });

  test("the same block twice is two blocks", () => {
    expect(splitBlocks("ok\n\n---\n\nok")).toHaveLength(3);
  });
});
