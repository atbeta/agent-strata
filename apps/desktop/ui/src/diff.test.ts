import { describe, expect, test } from "bun:test";
import { parsePatch } from "./patch";

// Captured from `createPatch` (diff 5.2.0), which is what the backends call.
// Written out rather than generated so the reader of this test can see the exact
// shape the parser has to survive.
const REGION = [
  "Index: src/x.ts",
  "===================================================================",
  "--- src/x.ts",
  "+++ src/x.ts",
  "@@ -1,3 +1,4 @@",
  "   one",
  "-  two",
  "+  TWO",
  "   three",
  "+  four",
  "",
].join("\n");

const NEW_FILE = [
  "Index: new.ts",
  "===================================================================",
  "--- new.ts",
  "+++ new.ts",
  "@@ -0,0 +1,2 @@",
  "+a",
  "+b",
  "",
].join("\n");

describe("parsePatch", () => {
  test("the file headers are dropped, the hunk body is not", () => {
    // `--- path` and `+++ path` start with the same characters as a removed and
    // an added line. Rendering them would put two phantom changes at the top of
    // every diff.
    const rows = parsePatch(REGION);
    expect(rows.filter((r) => r.kind === "del").map((r) => r.text)).toEqual(["  two"]);
    expect(rows.filter((r) => r.kind === "add").map((r) => r.text)).toEqual(["  TWO", "  four"]);
    expect(rows[0]!.kind).toBe("hunk");
    expect(rows.some((r) => r.kind === "ctx" && r.text.includes("Index:"))).toBe(false);
  });

  test("context lines keep their leading space, since it is part of the file", () => {
    expect(parsePatch(REGION).filter((r) => r.kind === "ctx").map((r) => r.text)).toEqual([
      "  one",
      "  three",
    ]);
  });

  test("a write of a new file is all additions", () => {
    const rows = parsePatch(NEW_FILE);
    expect(rows.filter((r) => r.kind === "add").map((r) => r.text)).toEqual(["a", "b"]);
    expect(rows.filter((r) => r.kind === "del")).toHaveLength(0);
  });

  test("the trailing newline of the patch is not a blank line to render", () => {
    expect(parsePatch(REGION).some((r) => r.kind === "ctx" && r.text === "")).toBe(false);
  });

  test("text that looks like a diff header inside a hunk still counts", () => {
    // A removed line whose content starts with "--" is emitted as "--- ...".
    // Only counting after the first @@ keeps it from vanishing.
    const rows = parsePatch(
      ["--- x.ts", "+++ x.ts", "@@ -1,1 +1,1 @@", "--- not a header", "+real"].join("\n"),
    );
    expect(rows.filter((r) => r.kind === "del").map((r) => r.text)).toEqual(["-- not a header"]);
    expect(rows.filter((r) => r.kind === "add").map((r) => r.text)).toEqual(["real"]);
  });

  test("no newline at end of file is a note, not a change", () => {
    const rows = parsePatch(["--- x", "+++ x", "@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b"].join("\n"));
    expect(rows.filter((r) => r.kind === "del").map((r) => r.text)).toEqual(["a"]);
    expect(rows.filter((r) => r.kind === "add").map((r) => r.text)).toEqual(["b"]);
  });
});