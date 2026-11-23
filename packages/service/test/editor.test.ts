import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { editorCommand, editorLaunch, type EditorLookup } from "../src/editor";

function lookup(partial: Partial<EditorLookup> & Pick<EditorLookup, "platform">): EditorLookup {
  return {
    which: () => undefined,
    exists: () => false,
    env: {},
    ...partial,
  };
}

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

  test("Windows launches Code.exe instead of the console code.cmd", () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-editor-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "a");
    const cmd = join("C:", "VS Code", "bin", "code.cmd");
    const exe = join("C:", "VS Code", "Code.exe");
    const result = editorCommand("vscode", file, lookup({
      platform: "win32",
      which: (name) => (name === "code" ? cmd : undefined),
      exists: (path) => path === exe,
    }));
    expect(result).toEqual({ cmd: [exe, file] });
  });

  test("an install without the shell command is still found", () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-editor-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "a");
    const exe = join("C:", "Users", "me", "AppData", "Local", "Programs", "Microsoft VS Code", "Code.exe");
    const result = editorCommand("vscode", file, lookup({
      platform: "win32",
      env: { LOCALAPPDATA: join("C:", "Users", "me", "AppData", "Local") },
      exists: (path) => path === exe,
    }));
    expect(result).toEqual({ cmd: [exe, file] });
  });

  test("a missing editor is a code the reader can be shown", () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-editor-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "a");
    expect(editorCommand("vscode", file, lookup({ platform: "win32" }))).toEqual({
      error: "VS Code is not installed",
      code: "vscode-missing",
    });
    expect(editorCommand("cursor", file, lookup({ platform: "linux" }))).toEqual({
      error: "Cursor is not installed",
      code: "cursor-missing",
    });
  });

  test("macOS opens the app bundle when the code command is not installed", () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-editor-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "a");
    const app = "/Applications/Visual Studio Code.app";
    const result = editorCommand("vscode", file, lookup({
      platform: "darwin",
      which: (name) => (name === "open" ? "/usr/bin/open" : undefined),
      exists: (path) => path === app,
    }));
    expect(result).toEqual({ cmd: ["/usr/bin/open", "-a", app, file] });
  });
});
