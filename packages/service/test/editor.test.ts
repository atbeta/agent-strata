import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { editorLaunch } from "../src/editor";

describe("opening a file in an editor", () => {
  test("accepts an absolute file for the two known editors", () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-editor-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "a");
    expect(editorLaunch("cursor", file)).toEqual({ bin: "cursor", file });
    expect(editorLaunch("vscode", file)).toEqual({ bin: "code", file });
  });

  test("refuses a relative path, a directory, and an unknown editor", () => {
    expect(editorLaunch("cursor", "a.txt")).toEqual({ error: "path must be absolute" });
    expect(editorLaunch("vim", "C:\\a.txt")).toEqual({ error: "editor must be cursor or vscode" });
    expect("error" in editorLaunch("cursor", tmpdir())).toBe(true);
  });
});
