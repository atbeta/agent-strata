import { describe, expect, test } from "bun:test";
import type { SessionView, ViewTail } from "./api";
import { createViewCache, filesKeyOf, tailMatches, viewFromTail } from "./view-cache";

const view = (turns: string[]): SessionView => ({
  session_id: "s",
  backend: "opencode",
  status: "active",
  busy: false,
  orphans: [],
  pending_questions: [],
  turns: turns.map((turn_id) => ({
    turn_id,
    user: [{ type: "text", text: turn_id }],
    assistant: [],
    tool_calls: [],
  })),
  pending_permissions: [],
  files_changed: [],
  totals: {
    input: 0,
    output: 0,
    cost_usd: 0,
    tool_calls: 0,
    cache_read: 0,
    cache_write: 0,
    reasoning: 0,
    tool_errors: 0,
    permissions_denied: 0,
  },
});

const tailOf = (v: SessionView, n = 1): ViewTail => {
  const offset = Math.max(0, v.turns.length - n);
  const { files_changed, ...rest } = v;
  return {
    ...rest,
    turns: v.turns.slice(offset),
    turn_offset: offset,
    prev_turn_id: offset > 0 ? v.turns[offset - 1]!.turn_id : null,
    files_key: filesKeyOf(v),
    files_changed,
  };
};

describe("reader view cache", () => {
  test("keeps the newest full views and hands back the same object", () => {
    const cache = createViewCache(2);
    const first = view(["a"]);
    const second = view(["b"]);
    const third = view(["c"]);
    cache.remember("1", first, "0:0");
    cache.remember("2", second);
    cache.remember("3", third);
    expect(cache.peek("1")).toBeUndefined();
    expect(cache.peek("2")?.view).toBe(second);
    expect(cache.peek("3")?.view).toBe(third);
    cache.remember("2", second);
    cache.remember("4", view(["d"]));
    expect(cache.peek("3")).toBeUndefined();
    expect(cache.peek("2")?.filesKey).toBeUndefined();
  });

  test("a later remember keeps the files key it already had", () => {
    const cache = createViewCache(2);
    const held = view(["a"]);
    cache.remember("1", held, "1:2");
    cache.remember("1", held);
    expect(cache.peek("1")).toEqual({ view: held, filesKey: "1:2" });
  });

  test("a tail is a preview, not a full transcript", () => {
    const preview = viewFromTail(tailOf(view(["a", "b"]), 1));
    expect(preview.turns.map((t) => t.turn_id)).toEqual(["b"]);
    expect("turn_offset" in preview).toBe(false);
    expect(preview.files_changed).toEqual([]);
  });

  test("an unchanged tail matches and a moved one does not", () => {
    const held = view(["a", "b"]);
    expect(tailMatches(held, tailOf(held))).toBe(true);
    const edited = structuredClone(held);
    edited.turns[1]!.user = [{ type: "text", text: "changed" }];
    expect(tailMatches(held, tailOf(edited))).toBe(false);
    const longer = view(["a", "b", "c"]);
    expect(tailMatches(held, tailOf(longer))).toBe(false);
  });
});
