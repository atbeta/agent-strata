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
 * Deleting one session used to quote the store's local-row tally — status
 * ticks plus both halves of every permission — so one session read as
 * "85 items will be deleted". The line is about that one session.
 */
describe("the delete line says what the delete takes", () => {
  test("a session with nothing only this machine knows names the one session", () => {
    const text = archivedDeleteWarning(data({ local: 0, rebuildable: 85 }));
    expect(text).toBe("会删除这个会话的后端记录和本地记录。");
    expect(text).not.toContain("85");
    expect(text).not.toContain("条");
  });

  test("a session with dozens of local-only rows still names the one session", () => {
    const text = archivedDeleteWarning(data({ local: 85, rebuildable: 1254 }));
    expect(text).toBe("会删除这个会话的后端记录和本地记录。");
    expect(text).not.toContain("85");
    expect(text).not.toContain("条");
  });

  test("a session the backend cannot delete says the backend keeps its copy", () => {
    const text = archivedDeleteWarning(data({ local: 2, can_delete: false }));
    expect(text).toBe("后端未连接或不能删除，只能处理本地记录；后端会话会保留。");
    expect(text).not.toContain("2 条");
  });
});
