import { describe, expect, test } from "bun:test";

/**
 * `i18n` stamps `document.documentElement.lang` while its module is evaluated,
 * and the test runtime has no DOM. Standing up the single property it touches
 * is all that takes; every locale-dependent case below then names its language
 * instead of inheriting whatever happens to be stored.
 */
const globals = globalThis as { document?: Document };
globals.document ??= { documentElement: {} } as Document;

const { locale, setLocale } = await import("./i18n");
const {
  diffStat,
  fmtLatency,
  permissionLabel,
  statusLabel,
  thinkingPreview,
  todoItems,
  toolHeadline,
  toolKind,
} = await import("./transcript-format");

/** Run `body` in `lang`, then hand the window back the language it had. */
function withLocale(lang: "zh" | "en", body: () => void): void {
  const previous = locale();
  setLocale(lang);
  try {
    body();
  } finally {
    setLocale(previous);
  }
}

describe("tool headlines", () => {
  test("bash uses the first command line", () => {
    withLocale("en", () => {
      expect(toolKind("bash")).toBe("shell");
      expect(toolHeadline({ tool: "bash", input: { command: "bun test\n--watch" } })).toEqual({
        kind: "shell",
        verb: "Bash",
        title: "bun test",
      });
    });
  });

  test("read and edit prefer a path", () => {
    withLocale("en", () => {
      expect(toolHeadline({ tool: "read", input: { filePath: "apps/desktop/ui/src/session-detail.tsx" } }).title).toBe(
        "apps/desktop/ui/src/session-detail.tsx",
      );
      expect(toolHeadline({ tool: "write", input: { path: "theme.css" } }).verb).toBe("Write");
    });
  });

  test("search keeps the pattern and directory", () => {
    withLocale("en", () => {
      expect(toolHeadline({ tool: "grep", input: { pattern: "tool.call", path: "packages" } }).title).toBe(
        "tool.call in packages",
      );
    });
  });

  test("plan uses the first todo", () => {
    withLocale("en", () => {
      expect(
        toolHeadline({
          tool: "todowrite",
          input: { todos: [{ content: "Style thinking", status: "completed" }] },
        }).title,
      ).toBe("Style thinking");
    });
    expect(todoItems({ todos: [{ content: "Style thinking", status: "completed" }, { nope: true }] })).toEqual([
      { content: "Style thinking", status: "completed" },
    ]);
  });

  test("a plan with no todo content counts its items", () => {
    withLocale("en", () => {
      expect(toolHeadline({ tool: "todowrite", input: { todos: [{ status: "pending" }] } }).title).toBe("1 item");
      expect(toolHeadline({ tool: "todowrite", input: { todos: [{}, {}, {}] } }).title).toBe("3 items");
    });
    withLocale("zh", () => {
      expect(toolHeadline({ tool: "todowrite", input: { todos: [{}, {}, {}] } })).toEqual({
        kind: "todo",
        verb: "计划",
        title: "3 项",
      });
    });
  });

  test("an unrecognised tool keeps its raw name in both languages", () => {
    // The fallback is the backend's identifier, not a word we chose to write.
    withLocale("en", () => {
      expect(toolHeadline({ tool: "browser_use", input: {} }).verb).toBe("browser_use");
    });
    withLocale("zh", () => {
      expect(toolHeadline({ tool: "browser_use", input: {} }).verb).toBe("browser_use");
    });
  });
});

describe("diff and labels", () => {
  test("counts added and removed lines", () => {
    const text = ["--- a/theme.css", "+++ b/theme.css", "@@ -1 +1 @@", "-old", "+new", "+also"].join("\n");
    expect(diffStat(text)).toEqual({ add: 2, del: 1 });
    expect(diffStat("{ \"ok\": true }")).toBeUndefined();
  });

  test("formats latency, permission, and a thinking preview", () => {
    withLocale("en", () => {
      expect(fmtLatency(840)).toBe("840ms");
      expect(fmtLatency(1500)).toBe("1.5s");
      expect(permissionLabel({ request_id: "r", decision: "deny", by: "user", reason: "outside the workspace" })).toBe(
        "Denied by you — outside the workspace",
      );
    });
    expect(thinkingPreview("  first line\nsecond")).toBe("first line second");
  });

  test("units are the same number in both languages", () => {
    // `840ms` and `1.5s` are units, not prose: nothing about them is Chinese.
    withLocale("en", () => {
      expect(fmtLatency(840)).toBe("840ms");
      expect(fmtLatency(1500)).toBe("1.5s");
      expect(fmtLatency(12000)).toBe("12s");
    });
    withLocale("zh", () => {
      expect(fmtLatency(840)).toBe("840ms");
      expect(fmtLatency(1500)).toBe("1.5s");
      expect(fmtLatency(12000)).toBe("12s");
    });
  });

  test("call status reads in the window's language", () => {
    withLocale("en", () => {
      expect(statusLabel("pending")).toBe("Running");
      expect(statusLabel("error")).toBe("Failed");
      expect(statusLabel("interrupted")).toBe("Stopped");
      expect(statusLabel("ok")).toBeUndefined();
    });
    withLocale("zh", () => {
      expect(statusLabel("pending")).toBe("运行中");
      expect(statusLabel("error")).toBe("失败");
      expect(statusLabel("interrupted")).toBe("已停止");
      expect(statusLabel("ok")).toBeUndefined();
    });
  });

  test("the permission sentence is composed per language", () => {
    // English puts the actor after the verb, Chinese before it, so the same
    // decision reads `Denied by you` in one window and `你已拒绝` in the other.
    withLocale("en", () => {
      expect(permissionLabel({ request_id: "r", decision: "deny", by: "user" })).toBe("Denied by you");
      expect(permissionLabel({ request_id: "r", decision: "deny", by: "policy" })).toBe("Denied by policy");
      expect(permissionLabel({ request_id: "r", decision: "allow", by: "auto" })).toBe("Allowed by the session");
      expect(permissionLabel({ request_id: "r", decision: "deny", by: "user", reason: "outside the workspace" })).toBe(
        "Denied by you — outside the workspace",
      );
      expect(permissionLabel({ request_id: "r" })).toBe("Waiting for permission");
      expect(permissionLabel(undefined)).toBeUndefined();
    });
    withLocale("zh", () => {
      expect(permissionLabel({ request_id: "r", decision: "deny", by: "user" })).toBe("你已拒绝");
      expect(permissionLabel({ request_id: "r", decision: "deny", by: "policy" })).toBe("策略已拒绝");
      expect(permissionLabel({ request_id: "r", decision: "allow", by: "auto" })).toBe("本会话已允许");
      // The reason is the backend's, and stays in the backend's words.
      expect(permissionLabel({ request_id: "r", decision: "deny", by: "user", reason: "outside the workspace" })).toBe(
        "你已拒绝 — outside the workspace",
      );
      expect(permissionLabel({ request_id: "r" })).toBe("等待授权");
      expect(permissionLabel(undefined)).toBeUndefined();
    });
  });

  test("an unattributed decision drops the actor instead of guessing one", () => {
    withLocale("en", () => {
      expect(permissionLabel({ request_id: "r", decision: "deny" })).toBe("Denied");
    });
    withLocale("zh", () => {
      expect(permissionLabel({ request_id: "r", decision: "deny" })).toBe("已拒绝");
    });
  });
});
