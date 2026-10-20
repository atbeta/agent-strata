import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  fmtElapsed,
  fmtLatency,
  hasMessageContent,
  isInteractiveTool,
  messageText,
  permissionLabel,
  statusLabel,
  toolStatusLabel,
  thinkingPreview,
  todoItems,
  toolHeadline,
  toolIcon,
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

  test("a question tool reads as a question and titles from its first entry", () => {
    withLocale("en", () => {
      expect(
        toolHeadline({
          tool: "question",
          input: { questions: [{ header: "Pick a style", question: "Which layout should the pane use?" }] },
        }),
      ).toEqual({ kind: "generic", verb: "Question", title: "Pick a style" });
      // No header falls back to the question itself; no usable text leaves "".
      expect(
        toolHeadline({ tool: "Question", input: { questions: [{ question: "Which layout?" }] } }).title,
      ).toBe("Which layout?");
      expect(toolHeadline({ tool: "question", input: { questions: [] } }).title).toBe("");
      expect(toolHeadline({ tool: "question", input: {} }).title).toBe("");
    });
    withLocale("zh", () => {
      expect(toolHeadline({ tool: "question", input: { questions: [{ header: "选样式" }] } })).toEqual({
        kind: "generic",
        verb: "提问",
        title: "选样式",
      });
    });
  });

  test("an unrecognised tool keeps its name capitalised in both languages", () => {
    // The fallback is the backend's identifier with the same leading capital
    // the named verbs carry — `browser_use` next to `Bash` reads `Browser_use`.
    withLocale("en", () => {
      expect(toolHeadline({ tool: "browser_use", input: {} }).verb).toBe("Browser_use");
      expect(toolHeadline({ tool: "Foo", input: {} }).verb).toBe("Foo");
    });
    withLocale("zh", () => {
      expect(toolHeadline({ tool: "browser_use", input: {} }).verb).toBe("Browser_use");
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
    // Collapsed thinking follows the latest line, not the opening one.
    expect(thinkingPreview("  first line\nsecond")).toBe("second");
    expect(thinkingPreview("first\n\n  latest  \n")).toBe("latest");
  });

  test("a thinking preview is the end of the latest line, cut by displayed width", () => {
    const wide = (n: number) => "字".repeat(n);
    const narrow = (n: number) => "a".repeat(n);
    // Same character budget, half the width: CJK is cut near twice as early,
    // and the cut keeps the end so a growing line keeps changing.
    expect(thinkingPreview(wide(89))).toBe(`…${wide(44)}`);
    expect(thinkingPreview(narrow(89))).toBe(`…${narrow(88)}`);
    // Inside the budget neither is touched.
    expect(thinkingPreview(wide(44))).toBe(wide(44));
    expect(thinkingPreview(narrow(88))).toBe(narrow(88));
    const full = narrow(100);
    expect(thinkingPreview(full + "z").endsWith("z")).toBe(true);
    expect(thinkingPreview(full)).not.toBe(thinkingPreview(full + "z"));
  });

  test("a cut thinking preview prefers a word boundary near the newest text", () => {
    // The window opens a few letters into a word and a space sits inside the
    // quarter-width backstop, so the preview starts at the next word.
    const near = `${"w".repeat(20)} ${"v".repeat(80)}`;
    expect(thinkingPreview(near)).toBe(`…${"v".repeat(80)}`);
    // The space is further back than that: jumping to it would drop the line.
    const far = `${"w".repeat(70)} ${"v".repeat(30)}`;
    expect(thinkingPreview(far)).toBe(`…${"w".repeat(57)} ${"v".repeat(30)}`);
    // One enormous unbreakable token still gets cut rather than overflowing.
    expect(thinkingPreview(`see ${"y".repeat(200)}`)).toBe(`…${"y".repeat(88)}`);
  });

  test("units are the same number in both languages", () => {
    // `840ms` and `1.5s` are units, not prose: nothing about them is Chinese.
    withLocale("en", () => {
      expect(fmtLatency(840)).toBe("840ms");
      expect(fmtLatency(1500)).toBe("1.5s");
      expect(fmtLatency(12000)).toBe("12s");
      expect(fmtLatency(125000)).toBe("2m 05s");
      expect(fmtLatency(36923000)).toBe("10h 15m");
    });
    withLocale("zh", () => {
      expect(fmtLatency(840)).toBe("840ms");
      expect(fmtLatency(1500)).toBe("1.5s");
      expect(fmtLatency(12000)).toBe("12s");
      expect(fmtLatency(125000)).toBe("2m 05s");
      expect(fmtLatency(36923000)).toBe("10h 15m");
    });
  });

  test("elapsed time ticks in whole seconds, then borrows latency's scale", () => {
    const start = "2026-10-20T10:00:00.000Z";
    const now = Date.parse("2026-10-20T10:02:05.000Z");
    // A stamp that means nothing is no answer — the row keeps its word then.
    expect(fmtElapsed("not a time", now)).toBeUndefined();
    // A clock slightly behind the event's reads as just started, never negative.
    expect(fmtElapsed("2026-10-20T10:00:01.000Z", Date.parse("2026-10-20T10:00:00.000Z"))).toBe("0s");
    // Whole seconds under a minute — a figure that ticks says 9s, not 9.0s.
    expect(fmtElapsed(start, Date.parse("2026-10-20T10:00:09.900Z"))).toBe("9s");
    expect(fmtElapsed(start, now)).toBe("2m 05s");
    expect(fmtElapsed(start, Date.parse("2026-10-20T11:15:00.000Z"))).toBe("1h 15m");
  });

  test("latency climbs ms → tenths → seconds → minutes → hours", () => {
    withLocale("en", () => {
      expect(fmtLatency(999)).toBe("999ms");
      expect(fmtLatency(1500)).toBe("1.5s");
      expect(fmtLatency(59000)).toBe("59s");
      // Minutes and hours floor the lower unit and zero-pad it: a remainder
      // that looks like rounding (`59.9s`) still reads `59s`.
      expect(fmtLatency(60000)).toBe("1m 00s");
      expect(fmtLatency(125000)).toBe("2m 05s");
      expect(fmtLatency(3599000)).toBe("59m 59s");
      expect(fmtLatency(3600000)).toBe("1h 00m");
      expect(fmtLatency(36923000)).toBe("10h 15m");
      expect(fmtLatency(undefined)).toBeUndefined();
    });
  });

  test("tools that wait on the reader count as interactive", () => {
    for (const tool of ["question", "ask", "askuserquestion", "ask_user_question", "Question", "ASK"]) {
      expect(isInteractiveTool(tool)).toBe(true);
    }
    for (const tool of ["bash", "read", "task", "browser_use", ""]) {
      expect(isInteractiveTool(tool)).toBe(false);
    }
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

  test("a pending call only runs while the session is live", () => {
    const pending = { status: "pending" as const, permission: undefined };
    const ask = {
      status: "pending" as const,
      permission: { request_id: "r" },
    };
    withLocale("en", () => {
      expect(toolStatusLabel(pending, true)).toEqual({ text: "Running", tone: "live" });
      expect(toolStatusLabel(pending, false)).toEqual({ text: "Unfinished", tone: "muted" });
      // A parked permission prompt is live waiting; orphaned, it is unfinished.
      expect(toolStatusLabel(ask, true)).toEqual({ text: "Needs permission", tone: "live" });
      expect(toolStatusLabel(ask, false)).toEqual({ text: "Unfinished", tone: "muted" });
      expect(toolStatusLabel({ status: "ok", permission: undefined }, true)).toBeUndefined();
      expect(toolStatusLabel({ status: "interrupted", permission: undefined }, true)).toEqual({
        text: "Stopped",
        tone: "muted",
      });
      expect(toolStatusLabel({ status: "error", permission: undefined }, true)).toEqual({
        text: "Failed",
        tone: "danger",
      });
      // A deny speaks first, whatever the status.
      expect(
        toolStatusLabel(
          { status: "pending", permission: { request_id: "r", decision: "deny", by: "user" } },
          false,
        ),
      ).toEqual({ text: "Denied", tone: "danger" });
    });
    withLocale("zh", () => {
      expect(toolStatusLabel(pending, false)).toEqual({ text: "未完成", tone: "muted" });
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

describe("tool call icons", () => {
  test("read is a document, not the files drawer", () => {
    expect(toolIcon("read")).toBe("page");
    expect(toolIcon("view")).toBe("page");
    expect(toolIcon("Read")).toBe("page");
  });

  test("a name search is a folder and a content search keeps the glass", () => {
    expect(toolIcon("glob")).toBe("folder");
    expect(toolIcon("Glob")).toBe("folder");
    expect(toolIcon("grep")).toBe("search");
    expect(toolIcon("search")).toBe("search");
  });

  test("a subagent is a fork, and an unknown tool stays a wrench", () => {
    expect(toolIcon("task")).toBe("fork");
    expect(toolIcon("Task")).toBe("fork");
    expect(toolIcon("browser_use")).toBe("wrench");
  });

  test("the remaining kinds keep the mark that matches the action", () => {
    expect(toolIcon("bash")).toBe("terminal");
    expect(toolIcon("execute")).toBe("terminal");
    expect(toolIcon("edit")).toBe("pencil");
    expect(toolIcon("write")).toBe("pencil");
    expect(toolIcon("webfetch")).toBe("globe");
    expect(toolIcon("websearch")).toBe("globe");
    expect(toolIcon("todowrite")).toBe("list");
  });

  test("the transcript row and the permission card both ask for that mark", () => {
    const transcript = readFileSync(join(import.meta.dir, "transcript.tsx"), "utf8");
    const prompts = readFileSync(join(import.meta.dir, "session-prompts.tsx"), "utf8");
    const icons = readFileSync(join(import.meta.dir, "icons.tsx"), "utf8");
    expect(transcript).toContain("toolIcon(props.call.tool)");
    expect(transcript).not.toContain('return "files"');
    expect(prompts).toContain("return toolIcon(tool)");
    expect(prompts).not.toContain('return "files"');
    expect(icons).toContain('name === "page"');
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
