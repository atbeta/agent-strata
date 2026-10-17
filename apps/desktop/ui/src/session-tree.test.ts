import { describe, expect, test } from "bun:test";
import { descendantSessions } from "./session-tree";

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
