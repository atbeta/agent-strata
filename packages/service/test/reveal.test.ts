import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { revealTarget } from "../src/reveal";

describe("revealing a path in the file manager", () => {
  test("a file selects, a directory opens", () => {
    if (process.platform !== "darwin") return;
    const dir = mkdtempSync(join(tmpdir(), "strata-reveal-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "a");
    expect(revealTarget(file)).toEqual({ cmd: ["open", "-R", file] });
    expect(revealTarget(dir)).toEqual({ cmd: ["open", dir] });
  });

  test("~ expands against the service's home", () => {
    const target = revealTarget("~");
    expect("error" in target).toBe(false);
    if (!("error" in target)) expect(target.cmd.at(-1)).not.toBe("~");
    expect(revealTarget("~/definitely-not-here")).toEqual({ error: "path does not exist" });
    expect(homedir()).toBeTruthy();
  });

  test("relative paths and missing paths are refused", () => {
    expect(revealTarget("a/b.txt")).toEqual({ error: "path must be absolute" });
    expect(revealTarget(42)).toEqual({ error: "path must be a string" });
    expect(revealTarget("/definitely/not/here")).toEqual({ error: "path does not exist" });
  });
});
