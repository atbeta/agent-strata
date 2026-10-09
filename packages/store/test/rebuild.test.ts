import { describe, expect, test } from "bun:test";
import { openStore } from "../src/index";
import { makeEvent, type EventInput } from "@agent-strata/schema";

const e = (session_id: string, type: string, data: object, id?: string): EventInput =>
  makeEvent({
    session_id,
    source: { backend: "test" },
    type,
    data,
    ...(id ? { id } : {}),
  } as EventInput);

describe("store: durable facts and rebuilds", () => {
  test("streaming snapshots are never stored", () => {
    const s = openStore(":memory:");
    s.append([
      e("s1", "session.started", { workspace: "/w" }),
      e("s1", "turn.assistant", { turn_id: "t", msg_id: "m", partial: true, content: [{ type: "text", text: "he" }] }),
      e("s1", "turn.assistant", { turn_id: "t", msg_id: "m", content: [{ type: "text", text: "hello" }] }),
    ]);
    const evs = s.read({ session_id: "s1" });
    expect(evs.map((x) => x.type)).toEqual(["session.started", "turn.assistant"]);
    expect((evs[1]!.data as { partial?: boolean }).partial).toBeUndefined();
    s.close();
  });

  test("replaceSession swaps the rebuildable types and keeps the rest", () => {
    const s = openStore(":memory:");
    s.append([
      e("s1", "session.started", { workspace: "/w", title: "old" }, "start"),
      e("s1", "tool.call", { turn_id: "t", call_id: "c", tool: "bash", input: {} }, "call"),
      e("s1", "permission.requested", { request_id: "r", call_id: "c", tool: "bash", input: {} }, "perm"),
    ]);
    const heard: string[] = [];
    s.subscribe((x) => heard.push(x.type));
    const n = s.replaceSession(
      "s1",
      [
        e("s1", "session.started", { workspace: "/w", title: "new" }, "start"),
        e("s1", "tool.call", { turn_id: "t", call_id: "c", tool: "grep", input: { pattern: "needle" } }, "call"),
      ],
      { replaceTypes: ["session.started", "tool.call"], mapper: "test-1" },
    );
    expect(n).toBe(2);
    expect(heard).toEqual([]);
    const evs = s.read({ session_id: "s1" });
    expect(evs.map((x) => x.type).sort()).toEqual(["permission.requested", "session.started", "tool.call"]);
    expect(evs.find((x) => x.type === "tool.call")!.data).toMatchObject({ tool: "grep" });
    const row = s.listSessions().find((r) => r.session_id === "s1")!;
    expect(row.title).toBe("new");
    expect(row.mapper).toBe("test-1");
    expect(s.sessionMapper("s1")).toBe("test-1");
    // the replaced call's text left the index with it
    expect(s.search("bash", { session_id: "s1" })).toHaveLength(0);
    expect(s.search("needle", { session_id: "s1" })).toHaveLength(1);
    s.close();
  });

  test("replaceSession refuses another session's events", () => {
    const s = openStore(":memory:");
    expect(() =>
      s.replaceSession("s1", [e("s2", "session.started", { workspace: "/w" })], { replaceTypes: ["session.started"] }),
    ).toThrow();
    s.close();
  });

  test("lastSeq and sessionMapper for known and unknown sessions", () => {
    const s = openStore(":memory:");
    s.append([e("s1", "session.started", { workspace: "/w" }), e("s1", "turn.user", { turn_id: "t", content: [] })]);
    expect(s.lastSeq("s1")).toBe(2);
    expect(s.lastSeq("nope")).toBe(0);
    expect(s.sessionMapper("s1")).toBeNull();
    expect(s.sessionMapper("nope")).toBeNull();
    s.close();
  });
});
