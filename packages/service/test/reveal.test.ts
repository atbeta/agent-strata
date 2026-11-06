import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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
    expect(revealTarget(file, [dir])).toEqual({ cmd: ["open", "-R", file] });
    expect(revealTarget(dir, [dir])).toEqual({ cmd: ["open", dir] });
  });

  test("~ expands against the service's home", () => {
    const target = revealTarget("~", [homedir()]);
    expect("error" in target).toBe(false);
    if (!("error" in target)) expect(target.cmd.at(-1)).not.toBe("~");
    expect(revealTarget("~/definitely-not-here", [homedir()])).toEqual({
      error: "path does not exist",
      code: "missing",
    });
    expect(homedir()).toBeTruthy();
  });

  test("relative paths and missing paths are refused", () => {
    expect(revealTarget("a/b.txt", [homedir()])).toEqual({
      error: "path must be absolute",
      code: "not-absolute",
    });
    expect(revealTarget(42, [homedir()])).toEqual({
      error: "path must be a string",
      code: "not-a-string",
    });
    expect(revealTarget("/definitely/not/here", [homedir()])).toEqual({
      error: "path does not exist",
      code: "missing",
    });
  });

  test("a path outside the allowed folders is refused", () => {
    const inside = mkdtempSync(join(tmpdir(), "strata-reveal-in-"));
    const outside = mkdtempSync(join(tmpdir(), "strata-reveal-out-"));
    const file = join(outside, "a.txt");
    writeFileSync(file, "a");
    expect(revealTarget(file, [inside])).toEqual({
      error: "path is outside the allowed folders",
      code: "outside",
    });
    // The same file passes once its own folder is one of the roots.
    expect("error" in revealTarget(file, [outside])).toBe(false);
    expect("error" in revealTarget(file, [homedir(), outside])).toBe(false);
  });

  test("a symlink out of an allowed folder is refused", () => {
    const root = mkdtempSync(join(tmpdir(), "strata-reveal-root-"));
    const outside = mkdtempSync(join(tmpdir(), "strata-reveal-out-"));
    const target = join(outside, "a.txt");
    writeFileSync(target, "a");
    const link = join(root, "link.txt");
    symlinkSync(target, link);
    // The link sits inside the root, but it points out of it.
    expect(revealTarget(link, [root])).toEqual({
      error: "path is outside the allowed folders",
      code: "outside",
    });
  });

  test("an application bundle is selected, not launched", () => {
    if (process.platform !== "darwin") return;
    const root = mkdtempSync(join(tmpdir(), "strata-reveal-"));
    const app = join(root, "Thing.app");
    mkdirSync(app);
    expect(revealTarget(app, [root])).toEqual({ cmd: ["open", "-R", app] });
  });
});
