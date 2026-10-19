import { describe, expect, test } from "bun:test";
import type { Turn } from "./api";
import { estimateSessionContextBreakdown } from "./session-context-breakdown";

const turn = (parts: Partial<Turn>): Turn => ({
  turn_id: "turn",
  assistant: [],
  tool_calls: [],
  ...parts,
});

describe("context breakdown", () => {
  test("no input means no breakdown", () => {
    expect(estimateSessionContextBreakdown([turn({ user: [{ type: "text", text: "hello" }] })], 0)).toEqual([]);
  });

  test("what the measured buckets cannot explain stays in other", () => {
    // 40 characters is ten estimated tokens; the request reports a hundred.
    const segments = estimateSessionContextBreakdown(
      [turn({ user: [{ type: "text", text: "x".repeat(40) }] })],
      100,
    );
    expect(segments).toEqual([
      { key: "user", tokens: 10, percent: 10, width: 10 },
      { key: "other", tokens: 90, percent: 90, width: 90 },
    ]);
  });

  test("estimates above the reported input are scaled down to it", () => {
    // user 10 + assistant 20 + tool 100 = 130 estimated against input 100.
    const segments = estimateSessionContextBreakdown(
      [
        turn({
          user: [{ type: "text", text: "u".repeat(40) }],
          assistant: [{ content: [{ type: "text", text: "a".repeat(80) }] }],
          tool_calls: [
            { call_id: "c", tool: "read", input: {}, status: "ok", output: "o".repeat(398) },
          ],
        }),
      ],
      100,
    );
    expect(segments).toEqual([
      { key: "user", tokens: 7, percent: 7, width: 7 },
      { key: "assistant", tokens: 15, percent: 15, width: 15 },
      { key: "tool", tokens: 76, percent: 76, width: 76 },
      { key: "other", tokens: 2, percent: 2, width: 2 },
    ]);
  });

  test("thinking counts with the assistant and a file reference with the user", () => {
    const segments = estimateSessionContextBreakdown(
      [
        turn({
          user: [{ type: "file_ref", path: "/tmp/" + "p".repeat(35) }],
          assistant: [{ content: [{ type: "thinking", text: "t".repeat(80) }] }],
        }),
      ],
      100,
    );
    expect(segments.map((s) => s.key)).toEqual(["user", "assistant", "other"]);
    expect(segments[0]!.tokens).toBe(10);
    expect(segments[1]!.tokens).toBe(20);
  });

  test("a single decimal keeps small shares visible in the legend", () => {
    const segments = estimateSessionContextBreakdown(
      [
        turn({
          user: [{ type: "text", text: "u".repeat(4) }],
          assistant: [{ content: [{ type: "text", text: "a".repeat(8) }] }],
        }),
      ],
      3,
    );
    expect(segments.map((s) => s.percent)).toEqual([33.3, 66.7]);
    expect(segments.reduce((sum, s) => sum + s.tokens, 0)).toBe(3);
  });

  test("a transcript with nothing measured is entirely other", () => {
    expect(estimateSessionContextBreakdown([], 50)).toEqual([
      { key: "other", tokens: 50, percent: 100, width: 100 },
    ]);
  });

  test("a compaction drops the history it replaced", () => {
    const segments = estimateSessionContextBreakdown(
      [
        turn({ user: [{ type: "text", text: "old".repeat(100) }], compaction: true }),
        turn({ user: [{ type: "text", text: "n".repeat(40) }] }),
      ],
      10,
    );
    // Only the post-compaction turn counts: 40 characters is ten tokens.
    expect(segments).toEqual([{ key: "user", tokens: 10, percent: 100, width: 100 }]);
  });
});
