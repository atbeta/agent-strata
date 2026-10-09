import { describe, expect, test } from "bun:test";
import { applyStreamingSnapshot, isStreamingSnapshotMessage } from "./live";
import type { SessionView } from "./api";

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
