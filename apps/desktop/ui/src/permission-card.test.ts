import { describe, expect, test } from "bun:test";
import { APP_NAME } from "./app-name";
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

  test("a tool that carries a command shows the command, not its document", () => {
    // `dev_start` is not in the shell set, and it used to fall through to the
    // JSON dump: braces, quotes and the field name between the reader and the
    // one line they are being asked to approve.
    expect(permissionView({ tool: "dev_start", input: { command: "npm run dev" } })).toEqual({
      kind: "command",
      command: "npm run dev",
    });
  });

  test("an ask about folders shows the folders, and any command as context", () => {
    expect(
      permissionView({
        tool: "external_directory",
        input: { directories: ["D:/work/a", "D:/work/b"], patterns: ["*"] },
      }),
    ).toEqual({ kind: "paths", paths: ["D:/work/a", "D:/work/b"] });
    expect(
      permissionView({
        tool: "external_directory",
        input: { directories: ["D:/work"], command: "echo probe" },
      }),
    ).toEqual({ kind: "paths", paths: ["D:/work"], command: "echo probe" });
  });

  test("an ask about one file shows the file and its folder", () => {
    // `external_directory` sends the file, its parent and a probe command. It
    // used to reach the JSON dump, so the card put braces between the reader
    // and the path they were deciding about.
    expect(
      permissionView({
        tool: "external_directory",
        input: {
          filepath: "D:/Codehub/SEIS/workflow-service/conf/config/application.yml",
          parentDir: "D:/Codehub/SEIS/workflow-service/conf/config",
          patterns: [1],
        },
      }),
    ).toEqual({
      kind: "paths",
      paths: ["D:/Codehub/SEIS/workflow-service/conf/config/application.yml"],
    });
    // A folder the file does not sit in is still worth naming.
    expect(
      permissionView({
        tool: "external_directory",
        input: { filepath: "D:/a/one.yml", parentDir: "D:/b" },
      }),
    ).toEqual({ kind: "paths", paths: ["D:/a/one.yml", "D:/b"] });
  });

  test("an edit with no diff still names the file rather than dumping it", () => {
    expect(permissionView({ tool: "edit", input: { filepath: "a.ts" } })).toEqual({
      kind: "paths",
      paths: ["a.ts"],
    });
  });

  test("anything else stays raw json", () => {
    expect(permissionView({ tool: "task", input: { description: "look" } })).toEqual({ kind: "json" });
  });
});

describe("window title", () => {
  test("counts only when someone is waiting", () => {
    expect(windowTitle(0)).toBe(APP_NAME);
    expect(windowTitle(2)).toBe(`(2) ${APP_NAME}`);
  });
});

describe("an ask with nothing to show", () => {
  test("no arguments, or arguments that carry nothing, draw no body", () => {
    // `dev_list` takes none; the card used to draw a framed `{}` under the
    // header — the loudest element on it, saying nothing.
    expect(permissionView({ tool: "dev_list", input: {} })).toEqual({ kind: "empty" });
    expect(permissionView({ tool: "search", input: { query: "" } })).toEqual({ kind: "empty" });
    expect(permissionView({ tool: "search", input: { paths: [] } })).toEqual({ kind: "empty" });
    expect(permissionView({ tool: "search", input: { query: null } })).toEqual({ kind: "empty" });
    expect(permissionView({ tool: "glob", input: { pattern: "", flags: {} } })).toEqual({ kind: "empty" });
  });

  test("one real field is still a body", () => {
    expect(permissionView({ tool: "search", input: { query: "session" } })).toEqual({ kind: "json" });
    expect(permissionView({ tool: "task", input: { description: "look" } })).toEqual({ kind: "json" });
  });
});
