import { describe, expect, test } from "bun:test";
import type { ContentBlock, Turn } from "./api";

/** i18n stamps documentElement.lang on module load; there is no DOM in bun:test. */
const globals = globalThis as { document?: Document };
globals.document ??= { documentElement: {} } as Document;

const { promptAt, promptEntries } = await import("./prompt-outline");

const text = (s: string): ContentBlock[] => [{ type: "text", text: s }];
const turn = (id: string, user: ContentBlock[] | undefined, assistant: ContentBlock[][] = []): Turn => ({
  turn_id: id,
  user,
  assistant: assistant.map((content) => ({ content })),
  tool_calls: [],
});

describe("promptEntries", () => {
  test("skips missing, empty, and blank user content", () => {
    const turns = [
      turn("a", undefined),
      turn("b", []),
      turn("c", text("   \n  ")),
      turn("d", [{ type: "thinking", text: "only private reasoning" }]),
      turn("e", text("real question")),
    ];
    const entries = promptEntries(turns);
    expect(entries.map((e) => e.turnId)).toEqual(["e"]);
  });

  test("tool-only turns never produce an entry", () => {
    const turns = [
      turn("a", text("ask one")),
      {
        turn_id: "b",
        assistant: [{ content: [] }],
        tool_calls: [
          { call_id: "c1", tool: "bash", input: { command: "ls" }, status: "ok" as const },
        ],
      },
      turn("c", text("ask two")),
    ];
    expect(promptEntries(turns).map((e) => e.number)).toEqual([1, 3]);
  });

  test("thinking in the user message is never copied into the prompt", () => {
    const [entry] = promptEntries([
      turn("a", [
        { type: "thinking", text: "drafted privately" },
        { type: "text", text: "public words" },
      ]),
    ]);
    expect(entry.prompt).toBe("public words");
  });

  test("text wins over attachments; basename fills in when there is no text", () => {
    const [both] = promptEntries([
      turn("a", [
        { type: "text", text: "look at this" },
        { type: "file_ref", path: "src/a.ts" },
        { type: "image", mime: "image/png", data: "AA" },
      ]),
    ]);
    expect(both.prompt).toBe("look at this");
    const [winPath] = promptEntries([turn("b", [{ type: "file_ref", path: "C:\\proj\\readme.md" }])]);
    expect(winPath.prompt).toBe("readme.md");
    const [img] = promptEntries([turn("c", [{ type: "image", mime: "image/png", data: "AA" }])]);
    expect(img.prompt).toBe("");
  });

  test("numbers keep the original turn index, gaps included", () => {
    const entries = promptEntries([turn("a", text("one")), turn("b", undefined), turn("c", text("two"))]);
    expect(entries.map((e) => [e.number, e.turnIndex])).toEqual([
      [1, 0],
      [3, 2],
    ]);
  });

  test("reverted turns keep the flag", () => {
    const [entry] = promptEntries([{ ...turn("a", text("was reverted")), reverted: true }]);
    expect(entry.reverted).toBe(true);
  });

  test("reply is the last non-blank public text, normalized and capped", () => {
    const long = "word ".repeat(80).trim();
    const [entry] = promptEntries([
      turn(
        "a",
        text("q"),
        [
          [{ type: "thinking", text: "hidden reasoning" }],
          [{ type: "text", text: "first answer" }],
          [{ type: "text", text: "   " }],
          [{ type: "text", text: `final\n\n  ${long}` }],
        ],
      ),
    ]);
    expect(entry.reply.startsWith("final word word")).toBe(true);
    expect(entry.reply.endsWith("...")).toBe(true);
    expect(entry.reply.length).toBeLessThanOrEqual(240);
    expect(entry.reply.includes("hidden")).toBe(false);
  });

  test("prompt flattens whitespace and caps at 160 chars", () => {
    const [entry] = promptEntries([turn("a", text(`multi\n\n  ${"x".repeat(200)}`))]);
    expect(entry.prompt.startsWith("multi xxxx")).toBe(true);
    expect(entry.prompt.endsWith("...")).toBe(true);
    expect(entry.prompt.length).toBeLessThanOrEqual(160);
  });

  test("unchanged turns keep their entry identity across a view rebuild", () => {
    const first = turn("a", text("one"));
    const second = turn("b", text("two"));
    const before = promptEntries([first, second]);
    const streamed: Turn = { ...second, assistant: [{ content: text("answer") }] };
    const after = promptEntries([first, streamed]);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]!.reply).toBe("answer");
    const shifted = promptEntries([turn("x", text("new first")), first, streamed]);
    expect(shifted[1]).not.toBe(before[0]);
    expect(shifted[1]!.turnIndex).toBe(1);
  });
});

describe("promptAt", () => {
  const entries = promptEntries([
    turn("a", text("one")),
    turn("b", undefined),
    turn("c", text("two")),
    turn("d", text("three")),
  ]);

  test("empty outline answers nothing", () => {
    expect(promptAt([], 5)).toBeUndefined();
  });

  test("before the first prompt anchors to the first", () => {
    // Entries themselves carry their row index; -1 means "above even row 0".
    expect(promptAt(entries, -1)?.turnId).toBe("a");
  });

  test("between prompts anchors to the one above", () => {
    expect(promptAt(entries, 1)?.turnId).toBe("a");
    expect(promptAt(entries, 2)?.turnId).toBe("c");
  });

  test("past the end anchors to the last", () => {
    expect(promptAt(entries, 99)?.turnId).toBe("d");
  });
});
