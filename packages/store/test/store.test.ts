import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/index";
import { makeEvent, type EventInput } from "@agent-core/schema";

const mk = (session_id: string, type: string, data: object, ts?: string): EventInput =>
  makeEvent({
    session_id,
    ts: ts ?? new Date().toISOString(),
    source: { backend: "test" },
    type,
    data,
  } as EventInput);

describe("store", () => {
  test("seq assignment across interleaved sessions", () => {
    const s = openStore(":memory:");
    const out = s.append([
      mk("a", "session.started", { workspace: "/a" }),
      mk("b", "session.started", { workspace: "/b" }),
      mk("a", "turn.user", { turn_id: "t", content: [] }),
      mk("b", "turn.user", { turn_id: "t", content: [] }),
      mk("a", "session.ended", { reason: "completed" }),
    ]);
    expect(out.map((e) => [e.session_id, e.seq])).toEqual([
      ["a", 1],
      ["b", 1],
      ["a", 2],
      ["b", 2],
      ["a", 3],
    ]);
    s.close();
  });

  test("idempotent re-append same and separate batches", () => {
    const s = openStore(":memory:");
    const e = mk("a", "session.started", { workspace: "/a" });
    const e2 = mk("a", "turn.user", { turn_id: "t", content: [] });
    const out1 = s.append([e, e, e2]);
    expect(out1[0]!.seq).toBe(1);
    expect(out1[1]!.seq).toBe(1); // dup returns existing
    expect(out1[2]!.seq).toBe(2);
    const out2 = s.append([e2, e]); // separate batch dups
    expect(out2[0]!.seq).toBe(2);
    expect(out2[1]!.seq).toBe(1);
    expect(s.read({ session_id: "a" }).length).toBe(2);
    s.close();
  });

  test("invalid event rolls back whole batch incl sessions", () => {
    const s = openStore(":memory:");
    const bad = {
      session_id: "a",
      ts: new Date().toISOString(),
      source: { backend: "test" },
      type: "session.ended",
      data: { reason: "bogus" },
    } as unknown as EventInput;
    expect(() => s.append([mk("a", "session.started", { workspace: "/a" }), bad])).toThrow();
    expect(s.read({ session_id: "a" })).toEqual([]);
    expect(s.listSessions()).toEqual([]);
    s.close();
  });

  test("read with cursor and limit", () => {
    const s = openStore(":memory:");
    s.append(
      Array.from({ length: 5 }, (_, i) =>
        mk("a", "file.changed", { path: `f${i}`, change: "add" }),
      ),
    );
    expect(s.read({ session_id: "a", limit: 2 }).map((e) => e.seq)).toEqual([1, 2]);
    expect(s.read({ session_id: "a", after_seq: 2, limit: 2 }).map((e) => e.seq)).toEqual([3, 4]);
    expect(s.read({ session_id: "a", after_seq: 4 }).map((e) => e.seq)).toEqual([5]);
    s.close();
  });

  test("reopen file DB persists and continues seq", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-core-"));
    const path = join(dir, "db.sqlite");
    try {
      const s1 = openStore(path);
      s1.append([mk("a", "session.started", { workspace: "/a" })]);
      s1.close();
      const s2 = openStore(path);
      const out = s2.append([mk("a", "turn.user", { turn_id: "t", content: [] })]);
      expect(out[0]!.seq).toBe(2);
      expect(s2.read({ session_id: "a" }).length).toBe(2);
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("search finds assistant content and tool output; session filter; hostile queries", () => {
    const s = openStore(":memory:");
    s.append([
      mk("a", "turn.assistant", {
        turn_id: "t",
        content: [{ type: "text", text: "the flux capacitor is ready" }],
      }),
      mk("a", "tool.result", { call_id: "c", status: "ok", output: "flux reading 42" }),
      mk("b", "turn.assistant", {
        turn_id: "t",
        content: [{ type: "text", text: "flux elsewhere" }],
      }),
    ]);
    const hits = s.search("flux");
    expect(hits.length).toBe(3);
    const onlyA = s.search("flux", { session_id: "a" });
    expect(onlyA.length).toBe(2);
    expect(onlyA.every((h) => h.event.session_id === "a")).toBe(true);
    expect(onlyA[0]!.snippet).toContain("flux");
    expect(() => s.search('"foo" OR')).not.toThrow();
    expect(() => s.search("AND ( * ^ NEAR/5")).not.toThrow();
    s.close();
  });

  test("subscribe fires post-commit in order, not for rollback", () => {
    const s = openStore(":memory:");
    const seen: string[] = [];
    const unsub = s.subscribe((e) => seen.push(`${e.session_id}:${e.seq}`));
    s.append([mk("a", "session.started", { workspace: "/a" }), mk("a", "file.changed", { path: "x", change: "add" })]);
    expect(seen).toEqual(["a:1", "a:2"]);
    const bad = { session_id: "a", ts: new Date().toISOString(), source: { backend: "t" }, type: "session.ended", data: { reason: "bogus" } } as unknown as EventInput;
    expect(() => s.append([mk("a", "file.changed", { path: "y", change: "add" }), bad])).toThrow();
    expect(seen).toEqual(["a:1", "a:2"]);
    unsub();
    s.append([mk("a", "file.changed", { path: "z", change: "add" })]);
    expect(seen).toEqual(["a:1", "a:2"]);
    s.close();
  });

  test("subscribe does not fire for idempotent duplicates", () => {
    const s = openStore(":memory:");
    const seen: string[] = [];
    s.subscribe((e) => seen.push(e.id));
    const e = mk("a", "session.started", { workspace: "/a" });
    const e2 = mk("a", "file.changed", { path: "x", change: "add" });
    const out = s.append([e, e2]);
    expect(seen).toEqual([out[0]!.id, out[1]!.id]);
    s.append([e]); // duplicate: returned but not notified
    expect(seen.length).toBe(2);
    s.close();
  });

  test("throwing listener does not break append or other listeners", () => {
    const s = openStore(":memory:");
    const seen: string[] = [];
    s.subscribe(() => {
      throw new Error("boom");
    });
    s.subscribe((e) => seen.push(e.id));
    const out = s.append([mk("a", "session.started", { workspace: "/a" })]);
    expect(out.length).toBe(1);
    expect(seen).toEqual([out[0]!.id]);
    s.close();
  });

  test("listSessions ordering by last_ts desc and backend filter", () => {
    const s = openStore(":memory:");
    s.append([
      mk("a", "session.started", { workspace: "/a" }, "2025-01-01T00:00:00Z"),
      mk("b", "session.started", { workspace: "/b", title: "B" }, "2025-01-02T00:00:00Z"),
    ]);
    s.append([mk("a", "file.changed", { path: "x", change: "add" }, "2025-01-03T00:00:00Z")]);
    const sessions = s.listSessions();
    expect(sessions.map((x) => x.session_id)).toEqual(["a", "b"]);
    expect(sessions[0]!.last_seq).toBe(2);
    expect(sessions[0]!.started_at).toBe("2025-01-01T00:00:00Z");
    expect(s.listSessions({ backend: "test" }).length).toBe(2);
    expect(s.listSessions({ backend: "nope" })).toEqual([]);
    s.close();
  });
});
