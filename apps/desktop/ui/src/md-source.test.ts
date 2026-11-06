import { describe, expect, test } from "bun:test";
import { isSourceBlock, leadingTag, sourceOf, tableWrapped } from "./md-source";

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

describe("a fragment shown as source", () => {
  test("gives a newline back where the renderer wrote a br", () => {
    expect(sourceOf("<x-a>a<br>b</x-a>")).toBe("<x-a>a\nb</x-a>");
    expect(sourceOf("a<BR />b")).toBe("a\nb");
    expect(sourceOf("a<br/>b")).toBe("a\nb");
    expect(sourceOf("<x-a>plain</x-a>")).toBe("<x-a>plain</x-a>");
  });
});

describe("a block of table parts", () => {
  test("is wrapped in the table it belongs to", () => {
    expect(tableWrapped("<thead><tr><th>a</th></tr></thead>")).toBe(
      "<table><thead><tr><th>a</th></tr></thead></table>",
    );
    expect(tableWrapped("\n  <tr><td>a</td></tr>")).toBe("<table>\n  <tr><td>a</td></tr></table>");
  });

  test("leaves a complete table and ordinary prose alone", () => {
    expect(tableWrapped("<table><tr><td>a</td></tr></table>")).toBe(
      "<table><tr><td>a</td></tr></table>",
    );
    expect(tableWrapped("本轮又推进 5 个组件")).toBe("本轮又推进 5 个组件");
    expect(tableWrapped("use <thead> in a sentence")).toBe("use <thead> in a sentence");
  });
});
