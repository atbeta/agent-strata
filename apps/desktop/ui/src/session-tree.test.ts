import { describe, expect, test } from "bun:test";
import { childBoardRows, descendantSessions } from "./session-tree";

const row = (id: string, parent?: string) => ({ summary: { session_id: id }, parent: parent ?? null });

describe("the sessions a session opened", () => {
  test("names children, grandchildren, and nothing else", () => {
    const rows = [row("a"), row("b", "a"), row("c", "b"), row("other")];
    expect([...descendantSessions(rows, "a")].sort()).toEqual(["b", "c"]);
    expect([...descendantSessions(rows, "b")]).toEqual(["c"]);
    expect([...descendantSessions(rows, "other")]).toEqual([]);
  });

  test("a row that points at itself is not its own child", () => {
    expect(descendantSessions([row("a", "a")], "a").size).toBe(0);
  });

  test("a cycle is walked once and does not hang", () => {
    const rows = [row("a", "b"), row("b", "a")];
    const found = descendantSessions(rows, "a");
    expect([...found]).toEqual(["b"]);
  });

  test("a parent that is not in the list leaves the row an orphan", () => {
    expect(descendantSessions([row("b", "gone")], "gone").size).toBe(0);
  });
});

describe("the board under a parent session", () => {
  const board = (
    id: string,
    parent: string | null,
    extra: { last_ts?: string; deleted?: boolean; busy?: boolean; needs_input?: boolean; status?: string } = {},
  ) => ({
    summary: { session_id: id, last_ts: extra.last_ts ?? "2026-01-01T00:00:00Z" },
    parent,
    deleted: extra.deleted,
    busy: extra.busy,
    needs_input: extra.needs_input,
    status: extra.status,
  });

  test("lists this session's own children, waiting first, and skips deleted ones", () => {
    const rows = [
      board("parent", null),
      board("idle-new", "parent", { last_ts: "2026-01-02T00:00:00Z" }),
      board("idle-old", "parent", { last_ts: "2026-01-01T00:00:00Z" }),
      board("busy", "parent", { busy: true, last_ts: "2026-01-01T12:00:00Z" }),
      board("ask", "parent", { needs_input: true, last_ts: "2026-01-01T06:00:00Z" }),
      board("gone", "parent", { deleted: true }),
      board("other", "elsewhere"),
      board("parent", "parent"),
    ];
    expect(childBoardRows(rows, "parent").map((row) => row.summary.session_id)).toEqual([
      "ask",
      "busy",
      "idle-new",
      "idle-old",
    ]);
  });
});
