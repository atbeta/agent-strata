import { describe, expect, test } from "bun:test";
import type { Turn } from "./api";
import { SEGMENT_MESSAGES, turnSegments } from "./turn-segments";

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
