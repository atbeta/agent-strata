import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileKind } from "./file-icon";

describe("file browser icons", () => {
  test("common source and document types have compact marks", () => {
    expect(fileKind("index.tsx").mark).toBe("TS");
    expect(fileKind("build.mjs").mark).toBe("JS");
    expect(fileKind("AGENTS.md").mark).toBe("MD");
    expect(fileKind("package.json").mark).toBe("{}");
    expect(fileKind("figs.py").mark).toBe("Py");
    expect(fileKind("slides.pptx").mark).toBe("PPT");
  });

  test("git, configuration, and unknown files use linear icons", () => {
    expect(fileKind(".gitignore").icon).toBe("branch");
    expect(fileKind("pyvenv.cfg").icon).toBe("gear");
    expect(fileKind(".DS_Store").icon).toBe("page");
    expect(fileKind("LICENSE").icon).toBe("page");
  });

  test("matching is case-insensitive", () => {
    expect(fileKind("README.MD").mark).toBe("MD");
    expect(fileKind("Component.TSX").mark).toBe("TS");
  });

  test("directory and file rows share SVG icon columns", () => {
    const src = readFileSync(join(import.meta.dir, "files.tsx"), "utf8");
    expect(src).toContain('name={open() ? "chevron" : "chevron-right"}');
    expect(src).toContain("<FileTypeIcon name={node.name} />");
    expect(src).not.toContain('{open() ? "▾" : "▸"}');
  });
});
