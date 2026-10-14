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
  assistantNotice,
  diffStat,
  fmtLatency,
  hasMessageContent,
  messageText,
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

  test("a task tool is its own kind and names the child", () => {
    expect(toolKind("task")).toBe("task");
    expect(toolKind("Task")).toBe("task");
    withLocale("en", () => {
      expect(
        toolHeadline({
          tool: "task",
          input: { description: "look up the plan", subagent_type: "explore", agent: "general" },
        }),
      ).toEqual({
        kind: "task",
        verb: "Subagent",
        title: "look up the plan",
      });
      expect(toolHeadline({ tool: "task", input: { subagent_type: "explore", agent: "general" } }).title).toBe(
        "explore",
      );
      expect(toolHeadline({ tool: "Task", input: { agent: "general" } }).title).toBe("general");
      expect(toolHeadline({ tool: "task", input: {} }).title).toBe("task");
    });
    withLocale("zh", () => {
      expect(toolHeadline({ tool: "task", input: { description: "查计划" } })).toEqual({
        kind: "task",
        verb: "子会话",
        title: "查计划",
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

  test("a thinking preview is cut by displayed width, not by character count", () => {
    const wide = (n: number) => "字".repeat(n);
    const narrow = (n: number) => "a".repeat(n);
    // Same character budget, half the width: CJK is cut near twice as early.
    expect(thinkingPreview(wide(89))).toBe(`${wide(44)}…`);
    expect(thinkingPreview(narrow(89))).toBe(`${narrow(88)}…`);
    // Inside the budget neither is touched.
    expect(thinkingPreview(wide(44))).toBe(wide(44));
    expect(thinkingPreview(narrow(88))).toBe(narrow(88));
  });

  test("a cut thinking preview prefers a word boundary", () => {
    // The last space sits 18 columns back — inside the quarter-width backstop —
    // so the cut backs off to it rather than landing mid-token.
    const near = `${"a".repeat(70)} ${"b".repeat(30)}`;
    expect(thinkingPreview(near)).toBe(`${"a".repeat(70)}…`);
    // Same shape, but the space is 38 back: too far to give up the content.
    const far = `${"a".repeat(50)} ${"b".repeat(60)}`;
    expect(thinkingPreview(far)).toBe(`${"a".repeat(50)} ${"b".repeat(37)}…`);
    // One enormous unbreakable token still gets cut rather than overflowing.
    expect(thinkingPreview(`see ${"y".repeat(200)}`)).toBe(`see ${"y".repeat(84)}…`);
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

describe("ACP tool kinds", () => {
  test("ACP's kinds read like their OpenCode counterparts", () => {
    expect(toolKind("execute")).toBe("shell");
    expect(toolKind("search")).toBe("search");
    expect(toolKind("delete")).toBe("edit");
    expect(toolKind("move")).toBe("edit");
  });
});

describe("messageText", () => {
  test("joins only text blocks, preserving markdown and whitespace", () => {
    const blocks = [
      { type: "thinking", text: "private reasoning" },
      { type: "text", text: "first line\n\n- a **list**" },
      { type: "image", mime: "image/png", data: "AAAA" },
      { type: "file_ref", path: "src/a.ts" },
      { type: "text", text: "  second  " },
    ] as const;
    expect(messageText(blocks)).toBe("first line\n\n- a **list**\n  second  ");
  });

  test("non-text and empty input yield an empty string", () => {
    expect(messageText([])).toBe("");
    expect(messageText([{ type: "thinking", text: "only thoughts" }])).toBe("");
  });
});

describe("hasMessageContent", () => {
  test("empty or blank content means the row renders nothing", () => {
    expect(hasMessageContent([])).toBe(false);
    expect(hasMessageContent([{ type: "text", text: "   " }])).toBe(false);
    expect(hasMessageContent([{ type: "text", text: "" }])).toBe(false);
    expect(hasMessageContent([{ type: "thinking", text: "  \n " }])).toBe(false);
  });

  test("non-blank text or thinking counts as content", () => {
    expect(hasMessageContent([{ type: "text", text: "hi" }])).toBe(true);
    expect(hasMessageContent([{ type: "thinking", text: "reasoning" }])).toBe(true);
    expect(
      hasMessageContent([
        { type: "text", text: "  " },
        { type: "thinking", text: "working it out" },
      ]),
    ).toBe(true);
  });

  test("images and file refs always show something", () => {
    expect(hasMessageContent([{ type: "image", mime: "image/png", data: "AAAA" }])).toBe(true);
    expect(hasMessageContent([{ type: "file_ref", path: "src/a.ts" }])).toBe(true);
  });
});

describe("assistantNotice", () => {
  const cancels = [
    "Aborted",
    "AbortError",
    "MessageAbortedError",
    "The operation was aborted.",
    "The operation was aborted",
    "  aborted  ",
  ];
  test.each(cancels)("known cancellation %j reads as stopped in English", (err) => {
    withLocale("en", () => {
      expect(assistantNotice(err)).toEqual({ kind: "stopped", text: "Generation stopped" });
    });
  });
  test.each(cancels)("known cancellation %j reads as stopped in Chinese", (err) => {
    withLocale("zh", () => {
      expect(assistantNotice(err)).toEqual({ kind: "stopped", text: "已停止生成" });
    });
  });

  test("missing or blank error means no notice", () => {
    expect(assistantNotice(undefined)).toBeUndefined();
    expect(assistantNotice("")).toBeUndefined();
    expect(assistantNotice("   ")).toBeUndefined();
  });

  test("genuine errors pass through unchanged", () => {
    expect(assistantNotice("API quota exceeded")).toEqual({ kind: "error", text: "API quota exceeded" });
    // Mentions of aborting do not downgrade a real failure.
    expect(assistantNotice("Request failed: Aborted upstream connection")).toEqual({
      kind: "error",
      text: "Request failed: Aborted upstream connection",
    });
  });
});
