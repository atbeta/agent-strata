import { describe, expect, test } from "bun:test";
import { splitPatch } from "./split-patch";

const PATCH = `--- a/a.ts
+++ b/a.ts
@@ -10,4 +10,4 @@
 same
-old
+new
 tail
`;

describe("a diff in two columns", () => {
  test("puts a removed line beside the line that replaced it", () => {
    const rows = splitPatch(PATCH);
    expect(rows[0]).toMatchObject({ kind: "hunk" });
    expect(rows[1]).toMatchObject({
      kind: "pair",
      left: { kind: "ctx", text: "same", line: 10 },
      right: { kind: "ctx", text: "same", line: 10 },
    });
    expect(rows[2]).toMatchObject({
      kind: "pair",
      left: { kind: "del", text: "old", line: 11 },
      right: { kind: "add", text: "new", line: 11 },
    });
    expect(rows[3]).toMatchObject({
      kind: "pair",
      left: { line: 12 },
      right: { kind: "ctx", text: "tail", line: 12 },
    });
  });

  test("pads the shorter side when lines were only added", () => {
    const rows = splitPatch("@@ -1,1 +1,2 @@\n keep\n+extra\n");
    expect(rows[2]).toMatchObject({
      kind: "pair",
      left: { kind: "empty", text: "" },
      right: { kind: "add", text: "extra", line: 2 },
    });
  });
});
