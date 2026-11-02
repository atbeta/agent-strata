import { describe, expect, test } from "bun:test";
import type { Turn } from "./api";
import { MESSAGE_CHARS, SEGMENT_MESSAGES, TOOL_ROW, TURN_BASE, estimateSegmentHeight, turnSegments } from "./turn-segments";

const turn = (id: string, messages: number): Turn =>
  ({
    turn_id: id,
    assistant: Array.from({ length: messages }, (_, i) => ({
      content: [{ type: "text", text: `m${i}` }],
    })),
    tool_calls: [],
  }) as Turn;

describe("turn segments", () => {
  test("a turn of a segment or less is one row named after the turn", () => {
    for (const n of [0, 1, SEGMENT_MESSAGES]) {
      const segs = turnSegments([turn("t1", n)]);
      expect(segs.length).toBe(1);
      expect(segs[0]).toMatchObject({ id: "t1", part: 0, last: true, msgFrom: 0, msgTo: n, turnIndex: 0 });
    }
  });

  test("a longer turn splits into fixed-size rows", () => {
    const segs = turnSegments([turn("t1", 25)]);
    expect(segs.map((s) => [s.id, s.msgFrom, s.msgTo, s.last])).toEqual([
      ["t1", 0, 12, false],
      ["t1#1", 12, 24, false],
      ["t1#2", 24, 25, true],
    ]);
  });

  test("turnIndex is the turn's position, not the row's", () => {
    const segs = turnSegments([turn("t1", 1), turn("t2", 25), turn("t3", 1)]);
    expect(segs.map((s) => [s.id, s.turnIndex])).toEqual([
      ["t1", 0],
      ["t2", 1],
      ["t2#1", 1],
      ["t2#2", 1],
      ["t3", 2],
    ]);
  });

  test("an unchanged turn keeps its segment objects", () => {
    const t = turn("t1", 25);
    const first = turnSegments([t]);
    const second = turnSegments([t], first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
  });

  test("a changed turn object gets fresh segments", () => {
    const first = turnSegments([turn("t1", 1)]);
    const second = turnSegments([turn("t1", 1)], first);
    expect(second[0]).not.toBe(first[0]);
  });

  test("a live turn crossing a boundary adds a row and unlasts the previous last", () => {
    const t = turn("t1", 12);
    const first = turnSegments([t]);
    expect(first.at(-1)!.last).toBe(true);
    const grown = { ...t, assistant: [...t.assistant, { content: [{ type: "text" as const, text: "m12" }] }] };
    const second = turnSegments([grown], first);
    expect(second.length).toBe(2);
    expect(second[0]).toMatchObject({ id: "t1", last: false, msgTo: 12 });
    expect(second[0]).not.toBe(first[0]);
    expect(second[1]).toMatchObject({ id: "t1#1", last: true, msgFrom: 12, msgTo: 13 });
  });
});

describe("how tall a row is expected to be", () => {
  const text = (n: number) => [{ type: "text" as const, text: "x".repeat(n) }];

  test("a turn's own block is counted once, on its first segment", () => {
    // The user message and the turn's padding live on the first segment only.
    // A continuation is messages alone, so it must not carry them again.
    const t = { turn_id: "t1", assistant: [{ content: text(100) }], tool_calls: [] } as unknown as Turn;
    const segs = turnSegments([{ ...t, assistant: Array.from({ length: 24 }, () => ({ content: text(100) })) } as unknown as Turn]);
    const first = estimateSegmentHeight(segs[0]!);
    const second = estimateSegmentHeight(segs[1]!);
    expect(first).toBe(TURN_BASE + 12 * 100 * MESSAGE_CHARS);
    expect(second).toBe(12 * 100 * MESSAGE_CHARS);
    expect(first - second).toBe(TURN_BASE);
  });

  test("a tool call adds its own row", () => {
    const t = {
      turn_id: "t1",
      assistant: [{ msg_id: "m0", content: text(100) }],
      tool_calls: [{ call_id: "c0", tool: "bash", input: {}, status: "ok", msg_id: "m0" }],
    } as unknown as Turn;
    const seg = turnSegments([t])[0]!;
    expect(estimateSegmentHeight(seg)).toBe(TURN_BASE + 100 * MESSAGE_CHARS + TOOL_ROW);
  });

  test("rows are not all one size", () => {
    const short = { turn_id: "t1", assistant: [{ content: text(200) }], tool_calls: [] } as unknown as Turn;
    const long = {
      turn_id: "t2",
      assistant: Array.from({ length: 12 }, () => ({ content: text(800) })),
      tool_calls: [],
    } as unknown as Turn;
    const a = estimateSegmentHeight(turnSegments([short])[0]!);
    const b = estimateSegmentHeight(turnSegments([long])[0]!);
    expect(b).toBeGreaterThan(a * 4);
  });
});
