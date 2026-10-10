import { describe, expect, test } from "bun:test";
import { permissionView, windowTitle } from "./permission-card";

const PATCH = "@@ -1 +1 @@\n-a\n+b\n";

describe("permission card body", () => {
  test("a shell tool shows the command", () => {
    expect(permissionView({ tool: "bash", input: { command: "ls -la", patterns: ["ls"] } })).toEqual({
      kind: "command",
      command: "ls -la",
    });
    expect(permissionView({ tool: "pwsh", input: { patterns: ["Get-ChildItem"] } })).toEqual({
      kind: "command",
      command: "Get-ChildItem",
    });
  });

  test("an edit or write shows its diff and path", () => {
    expect(permissionView({ tool: "edit", input: { filepath: "src/a.ts", diff: PATCH } })).toEqual({
      kind: "diff",
      path: "src/a.ts",
      patch: PATCH,
    });
    expect(
      permissionView({ tool: "write", input: { filePath: "b.ts", filediff: { patch: PATCH } } }).kind,
    ).toBe("diff");
  });

  test("webfetch shows the url, from the field or from the patterns", () => {
    expect(permissionView({ tool: "webfetch", input: { url: "https://x.test" } })).toEqual({
      kind: "url",
      url: "https://x.test",
    });
    expect(permissionView({ tool: "webfetch", input: { patterns: ["https://x.test/*"] } })).toEqual({
      kind: "url",
      url: "https://x.test/*",
    });
  });

  test("anything else stays raw json", () => {
    expect(permissionView({ tool: "edit", input: { filepath: "a.ts" } })).toEqual({ kind: "json" });
    expect(permissionView({ tool: "task", input: { description: "look" } })).toEqual({ kind: "json" });
  });
});

describe("window title", () => {
  test("counts only when someone is waiting", () => {
    expect(windowTitle(0)).toBe("Agent Strata");
    expect(windowTitle(2)).toBe("(2) Agent Strata");
  });
});
