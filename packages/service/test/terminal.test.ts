import { describe, expect, test } from "bun:test";
import { isPtyMeta, shellCommand, terminalSize, terminalTitle } from "../src/terminal";

const shells = [
  { name: "pwsh", path: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", acceptable: true },
  { name: "nope", path: "C:/evil.exe", acceptable: false },
];

describe("terminal choices", () => {
  test("an omitted shell is the backend default", () => {
    expect(shellCommand(shells, undefined)).toEqual({ ok: true });
    expect(shellCommand(shells, "")).toEqual({ ok: true });
  });

  test("a named shell is the path the backend listed, never the caller's string", () => {
    expect(shellCommand(shells, "pwsh")).toEqual({
      ok: true,
      command: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    });
    expect(shellCommand(shells, "C:/evil.exe").ok).toBe(false);
    expect(shellCommand(shells, "nope").ok).toBe(false);
  });

  test("a title is a short single line", () => {
    expect(terminalTitle(undefined)).toEqual({ ok: true });
    expect(terminalTitle("  构建\n脚本  ")).toEqual({ ok: true, title: "构建脚本" });
    expect(terminalTitle(3).ok).toBe(false);
  });

  test("a size is a small integer grid", () => {
    expect(terminalSize(24, 80)).toEqual({ rows: 24, cols: 80 });
    expect(terminalSize(0, 80)).toBeUndefined();
    expect(terminalSize(24.5, 80)).toBeUndefined();
  });

  test("a cursor frame is not terminal output", () => {
    const meta = new Uint8Array([0, ...new TextEncoder().encode('{"cursor":12}')]);
    expect(isPtyMeta(meta)).toBe(true);
    expect(isPtyMeta(new TextEncoder().encode("hello"))).toBe(false);
    expect(isPtyMeta(new Uint8Array([0, 1, 2]))).toBe(false);
  });
});
