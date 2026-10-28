import { describe, expect, test } from "bun:test";
import { archivedDeleteWarning } from "./archived-warning";
import type { SessionData } from "./maintenance-api";

const data = (over: Partial<SessionData> = {}): SessionData => ({
  session_id: "a",
  title: null,
  workspace: null,
  last_ts: null,
  rebuildable: 12,
  local: 0,
  rebuildable_bytes: 1000,
  local_bytes: 0,
  backend: true,
  can_delete: true,
  ...over,
});

/**
 * Deleting an archived session is the one thing in the sidebar that cannot be
 * undone, so the line above the button has to say what goes with it. The line
 * used to end in "0 local-only rows cannot be rebuilt" — a count of zero
 * dressed as a loss, which reads like something went wrong rather than like
 * there is nothing there to lose.
 */
describe("the delete line says what the delete takes", () => {
  test("a session with nothing only this machine knows says nothing about a count", () => {
    const text = archivedDeleteWarning(data({ local: 0 }));
    expect(text).toBe("会删除后端会话和本地记录。");
    expect(text).not.toContain("0");
    expect(text).not.toContain("无法重建");
  });

  test("a session with local-only rows says how many cannot be rebuilt", () => {
    const text = archivedDeleteWarning(data({ local: 3 }));
    expect(text).toContain("3 条");
    expect(text).toContain("无法重建");
  });

  test("a session the backend cannot delete says the backend keeps its copy", () => {
    const text = archivedDeleteWarning(data({ local: 2, can_delete: false }));
    expect(text).toBe("后端未连接或不能删除，只能处理本地记录；后端会话会保留。");
    expect(text).not.toContain("2 条");
  });
});
