import { describe, expect, test } from "bun:test";
import { applyStreamingSnapshot, isStreamingSnapshotMessage, mergeViewTail } from "./live";
import type { SessionView, ViewTail } from "./api";

const base = (): SessionView => ({
  session_id: "s",
  backend: "opencode",
  status: "active",
  turns: [
    {
      turn_id: "u1",
      user: [{ type: "text", text: "hi" }],
      assistant: [{ content: [{ type: "text", text: "done" }], msg_id: "a1" }],
      tool_calls: [],
    },
  ],
  pending_permissions: [],
  files_changed: [],
  totals: {
    input: 0, output: 0, cost_usd: 0, tool_calls: 0, cache_read: 0, cache_write: 0,
    reasoning: 0, tool_errors: 0, permissions_denied: 0,
  },
});

describe("streaming snapshots in the reader's view", () => {
  test("a new message joins its turn as still being written", () => {
    const v = applyStreamingSnapshot(base(), { turn_id: "u1", msg_id: "a2", content: [{ type: "text", text: "wri" }] });
    expect(v.turns[0]!.assistant).toHaveLength(2);
    expect(v.turns[0]!.assistant[1]).toMatchObject({ msg_id: "a2", partial: true });
  });

  test("a later snapshot replaces the earlier one", () => {
    const once = applyStreamingSnapshot(base(), { turn_id: "u1", msg_id: "a2", content: [{ type: "text", text: "wri" }] });
    const twice = applyStreamingSnapshot(once, { turn_id: "u1", msg_id: "a2", content: [{ type: "text", text: "writing" }] });
    expect(twice.turns[0]!.assistant).toHaveLength(2);
    expect(twice.turns[0]!.assistant[1]!.content).toEqual([{ type: "text", text: "writing" }]);
  });

  test("a finished message is left alone", () => {
    const v = base();
    expect(applyStreamingSnapshot(v, { turn_id: "u1", msg_id: "a1", content: [] })).toBe(v);
  });

  test("an unseen turn is added", () => {
    const v = applyStreamingSnapshot(base(), { turn_id: "u2", msg_id: "b1", content: [{ type: "text", text: "x" }] });
    expect(v.turns.map((t) => t.turn_id)).toEqual(["u1", "u2"]);
  });

  test("only streaming snapshot messages are recognised", () => {
    expect(isStreamingSnapshotMessage(JSON.stringify({ type: "turn.assistant", data: { partial: true } }))).toBe(true);
    expect(isStreamingSnapshotMessage(JSON.stringify({ type: "turn.assistant", data: {} }))).toBe(false);
    expect(isStreamingSnapshotMessage("not json")).toBe(false);
  });
});

describe("a view's tail laid over the one the reader holds", () => {
  const held = (): SessionView => {
    const v = base();
    v.turns.push({ turn_id: "u2", user: [{ type: "text", text: "next" }], assistant: [], tool_calls: [] });
    v.files_changed = [
      { path: "/a", change: "modify", count: 1, additions: 1, deletions: 0, edits: [], unexplained: false },
    ] as unknown as SessionView["files_changed"];
    return v;
  };
  const tail = (over: Partial<ViewTail> = {}): ViewTail => {
    const { files_changed: _files, ...rest } = base();
    return {
      ...rest,
      turns: [
        {
          turn_id: "u2",
          user: [{ type: "text", text: "next" }],
          assistant: [{ content: [{ type: "text", text: "on it" }], msg_id: "a2" }],
          tool_calls: [],
        },
      ],
      turn_offset: 1,
      prev_turn_id: "u1",
      files_key: "1:1",
      ...over,
    };
  };

  test("turns from the offset on are replaced and the ones before are kept", () => {
    const v = held();
    const merged = mergeViewTail(v, tail())!;
    expect(merged.turns.map((t) => t.turn_id)).toEqual(["u1", "u2"]);
    expect(merged.turns[0]).toBe(v.turns[0]);
    expect(merged.turns[1]!.assistant[0]!.msg_id).toBe("a2");
  });

  test("a tail without files keeps the reader's files", () => {
    const v = held();
    expect(mergeViewTail(v, tail())!.files_changed).toBe(v.files_changed);
  });

  test("a tail with files replaces them", () => {
    expect(mergeViewTail(held(), tail({ files_changed: [] }))!.files_changed).toEqual([]);
  });

  test("a tail that starts past what the reader holds asks for the full view", () => {
    expect(mergeViewTail(held(), tail({ turn_offset: 5, prev_turn_id: "u9" }))).toBeUndefined();
  });

  test("a tail after a turn the reader does not have asks for the full view", () => {
    expect(mergeViewTail(held(), tail({ prev_turn_id: "other" }))).toBeUndefined();
  });

  test("the merged view carries none of the tail's bookkeeping", () => {
    const merged = mergeViewTail(held(), tail()) as unknown as Record<string, unknown>;
    expect(merged.turn_offset).toBeUndefined();
    expect(merged.prev_turn_id).toBeUndefined();
    expect(merged.files_key).toBeUndefined();
  });
});
