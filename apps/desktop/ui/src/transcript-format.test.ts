import { describe, expect, test } from "bun:test";
import {
  diffStat,
  fmtLatency,
  permissionLabel,
  thinkingPreview,
  todoItems,
  toolHeadline,
  toolKind,
} from "./transcript-format";

describe("tool headlines", () => {
  test("bash uses the first command line", () => {
    expect(toolKind("bash")).toBe("shell");
    expect(toolHeadline({ tool: "bash", input: { command: "bun test\n--watch" } })).toEqual({
      kind: "shell",
      verb: "Bash",
      title: "bun test",
    });
  });

  test("read and edit prefer a path", () => {
    expect(toolHeadline({ tool: "read", input: { filePath: "apps/desktop/ui/src/session-detail.tsx" } }).title).toBe(
      "apps/desktop/ui/src/session-detail.tsx",
    );
    expect(toolHeadline({ tool: "write", input: { path: "theme.css" } }).verb).toBe("Write");
  });

  test("search keeps the pattern and directory", () => {
    expect(toolHeadline({ tool: "grep", input: { pattern: "tool.call", path: "packages" } }).title).toBe(
      "tool.call in packages",
    );
  });

  test("plan uses the first todo", () => {
    expect(
      toolHeadline({
        tool: "todowrite",
        input: { todos: [{ content: "Style thinking", status: "completed" }] },
      }).title,
    ).toBe("Style thinking");
    expect(todoItems({ todos: [{ content: "Style thinking", status: "completed" }, { nope: true }] })).toEqual([
      { content: "Style thinking", status: "completed" },
    ]);
  });
});

describe("diff and labels", () => {
  test("counts added and removed lines", () => {
    const text = ["--- a/theme.css", "+++ b/theme.css", "@@ -1 +1 @@", "-old", "+new", "+also"].join("\n");
    expect(diffStat(text)).toEqual({ add: 2, del: 1 });
    expect(diffStat("{ \"ok\": true }")).toBeUndefined();
  });

  test("formats latency, permission, and a thinking preview", () => {
    expect(fmtLatency(840)).toBe("840ms");
    expect(fmtLatency(1500)).toBe("1.5s");
    expect(permissionLabel({ request_id: "r", decision: "deny", by: "user", reason: "outside the workspace" })).toBe(
      "Denied by you — outside the workspace",
    );
    expect(thinkingPreview("  first line\nsecond")).toBe("first line second");
  });
});
