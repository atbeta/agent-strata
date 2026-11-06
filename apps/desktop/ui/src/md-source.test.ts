import { describe, expect, test } from "bun:test";
import { isSourceBlock, leadingTag } from "./md-source";

describe("a block that opens with a tag", () => {
  test("names the tag it opens with", () => {
    expect(leadingTag("<x-option v-for=\"a in b\">")).toBe("x-option");
    expect(leadingTag("  <details>")).toBe("details");
    expect(leadingTag("<x-card/>")).toBe("x-card");
  });

  test("is not a tag when the block is prose", () => {
    expect(leadingTag("use <x-option> here")).toBeUndefined();
    expect(leadingTag("a < b")).toBeUndefined();
    expect(leadingTag("")).toBeUndefined();
  });

  test("is source only when the sanitiser drops the tag", () => {
    const dropped = new Set(["x-option", "script"]);
    const isDropped = (tag: string) => dropped.has(tag);
    expect(isSourceBlock("<x-option :label=\"ops.label\">{{ops.label}}</x-option>", isDropped)).toBe(true);
    expect(isSourceBlock("<script>alert(1)</script>", isDropped)).toBe(true);
    expect(isSourceBlock("<details><summary>more</summary></details>", isDropped)).toBe(false);
    expect(isSourceBlock("use <x-option> here", isDropped)).toBe(false);
  });
});
