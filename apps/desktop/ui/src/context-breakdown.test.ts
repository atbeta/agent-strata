import { describe, expect, test } from "bun:test";
import { contextBreakdown } from "./context-breakdown";
import type { ContentBlock, Turn } from "./api";

const turn = (patch: Partial<Turn> = {}): Turn =>
  ({
    turn_id: "t1",
    assistant: [],
    tool_calls: [],
    ...patch,
  }) as Turn;

const text = (value: string): ContentBlock[] => [{ type: "text", text: value }];

describe("contextBreakdown", () => {
  test("estimates user, assistant and tool content, and leaves the rest to other", () => {
    const parts = contextBreakdown(
      [
        turn({
          user: text("hello world"),
          assistant: [{ content: text("assistant response") }],
        }),
      ],
      100,
    );
    const map = Object.fromEntries(parts.map((p) => [p.key, p.tokens]));
    // 11 chars → 3 tokens, 18 chars → 5 tokens, 100 − 8 → other.
    expect(map.user).toBe(3);
    expect(map.assistant).toBe(5);
    expect(map.other).toBe(92);
  });

  test("counts a tool call by its argument keys and its output", () => {
    const parts = contextBreakdown(
      [
        turn({
          tool_calls: [
            {
              call_id: "c1",
              tool: "read",
              input: { path: "a", limit: 10 },
              status: "ok",
              output: "x".repeat(40),
            },
          ],
        }),
      ],
      100,
    );
    const tool = parts.find((p) => p.key === "tool");
    expect(tool?.tokens).toBe(18);
  });

  test("scales down rather than drawing past the window", () => {
    const parts = contextBreakdown(
      [turn({ user: text("x".repeat(4000)) })],
      10,
    );
    const total = parts.reduce((sum, p) => sum + p.tokens, 0);
    expect(total).toBeLessThanOrEqual(10);
    expect(parts.every((p) => p.width <= 100)).toBe(true);
  });

  test("has nothing to say without a reported input", () => {
    expect(contextBreakdown([turn()], 0)).toEqual([]);
    expect(contextBreakdown([turn()], Number.NaN)).toEqual([]);
  });
});
