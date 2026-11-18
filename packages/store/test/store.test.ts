import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../src/index";
import { Database } from "bun:sqlite";
import { makeEvent, type EventInput } from "@agent-strata/schema";

const mk = (session_id: string, type: string, data: object, ts?: string): EventInput =>
  makeEvent({
    session_id,
    ts: ts ?? new Date().toISOString(),
    source: { backend: "test" },
    type,
    data,
  } as EventInput);

describe("store", () => {
  test("deletedSessions lists only sessions carrying the marker", () => {
    const s = openStore(":memory:");
    s.append([
      mk("a", "session.started", { workspace: "/a" }),
      mk("b", "session.started", { workspace: "/b" }),
      mk("a", "session.deleted", {}),
    ]);
    expect(s.deletedSessions()).toEqual(["a"]);
    s.close();
  });

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
    const dir = mkdtempSync(join(tmpdir(), "agent-strata-"));
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

  test("openStore creates missing parent directories for a nested path", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-strata-"));
    // fresh ~/.agent-strata-style layout: parent dir does not exist yet
    const path = join(dir, "nested", "deeper", "db.sqlite");
    try {
      const s = openStore(path);
      s.append([mk("a", "session.started", { workspace: "/a" })]);
      expect(existsSync(join(dir, "nested", "deeper"))).toBe(true);
      expect(s.read({ session_id: "a" }).length).toBe(1);
      s.close();
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

  /**
   * `unicode61` splits on word boundaries, and Chinese has none — the whole
   * sentence was a single token, so a search for `搜索` matched nothing at all.
   * The index now separates each character, and the query is turned into a
   * phrase so the characters still have to be adjacent.
   */
  test("search finds Chinese words of two characters", () => {
    const s = openStore(":memory:");
    s.append([
      mk("a", "turn.assistant", {
        turn_id: "t",
        content: [{ type: "text", text: "当前的全文搜索不支持中文。" }],
      }),
    ]);
    // Two characters is the shortest word that carries meaning in Chinese, and
    // it is the length that a 3-gram index cannot answer at all.
    expect(s.search("搜索").length).toBe(1);
    expect(s.search("中文").length).toBe(1);
    expect(s.search("全文").length).toBe(1);
    expect(s.search("全文搜索").length).toBe(1);
    // A substring that never appears.
    expect(s.search("数据库").length).toBe(0);
    s.close();
  });

  test("a Chinese phrase matches only adjacent characters", () => {
    const s = openStore(":memory:");
    s.append([
      mk("a", "turn.assistant", {
        turn_id: "t",
        content: [{ type: "text", text: "中国文字很古老" }],
      }),
      mk("b", "turn.assistant", {
        turn_id: "t",
        content: [{ type: "text", text: "中文很好学" }],
      }),
    ]);
    // Both documents contain 中 and 文, but only one has them together. An AND
    // of the two characters would match both; the phrase matches one.
    const hits = s.search("中文");
    expect(hits.length).toBe(1);
    expect(hits[0]!.event.session_id).toBe("b");
    s.close();
  });

  test("the snippet of a Chinese hit reads without the index's spaces", () => {
    const s = openStore(":memory:");
    s.append([
      mk("a", "turn.assistant", {
        turn_id: "t",
        content: [{ type: "text", text: "前言很长。当前的全文搜索不支持中文，需要修复。" }],
      }),
    ]);
    const hit = s.search("搜索")[0]!;
    expect(hit.snippet).toContain("搜索");
    // The segmentation spaces are an indexing detail; the reader must not see
    // them between characters that were written without any.
    expect(hit.snippet).not.toMatch(/全\s+文/);
    expect(hit.snippet).not.toMatch(/搜\s+索/);
    s.close();
  });

  test("Chinese and English in one query both match, and English is unchanged", () => {
    const s = openStore(":memory:");
    s.append([
      mk("a", "turn.assistant", {
        turn_id: "t",
        content: [{ type: "text", text: "FTS 全文搜索 uses unicode61 tokenizer" }],
      }),
    ]);
    expect(s.search("全文").length).toBe(1);
    expect(s.search("unicode61").length).toBe(1);
    expect(s.search("tokenizer").length).toBe(1);
    // Mixed: both halves have to be present in the same document.
    expect(s.search("全文 tokenizer").length).toBe(1);
    expect(s.search("全文 missing").length).toBe(0);
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

  test("an explicit source clock rewrites a stored event and the session list", () => {
    const s = openStore(":memory:");
    const ingested = "2026-10-08T17:28:29.520Z";
    const activity = "2026-10-02T03:11:00.000Z";
    const first = mk("a", "session.started", { workspace: "/a" }, ingested);
    s.append([first]);
    expect(s.listSessions()[0]!.last_ts).toBe(ingested);
    s.append([{ ...first, ts: activity }]);
    const again = s.read({ session_id: "a" });
    expect(again).toHaveLength(1);
    expect(again[0]!.ts).toBe(activity);
    expect(s.listSessions()[0]!.last_ts).toBe(activity);
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

describe("store.query", () => {
  const seed = (s: ReturnType<typeof openStore>) =>
    s.append([
      mk("a", "session.started", { workspace: "/a" }, "2026-01-01T00:00:00Z"),
      mk("b", "session.started", { workspace: "/b" }, "2026-01-01T00:01:00Z"),
      mk("a", "turn.user", { turn_id: "t1", content: [{ type: "text", text: "hello auth bug" }] }, "2026-01-01T00:02:00Z"),
      mk("a", "tool.call", { turn_id: "t1", call_id: "c1", tool: "bash", input: { command: "ls" } }, "2026-01-01T00:03:00Z"),
      mk("b", "turn.user", { turn_id: "t2", content: [{ type: "text", text: "other task" }] }, "2026-01-01T00:04:00Z"),
      mk("a", "tool.result", { turn_id: "t1", call_id: "c1", status: "ok", output: "done auth" }, "2026-01-01T00:05:00Z"),
    ]);

  test("filters by session, type, time, backend", () => {
    const s = openStore(":memory:");
    seed(s);
    expect(s.query({ session_id: "a" }).length).toBe(4);
    expect(s.query({ types: ["tool.call", "tool.result"] }).map((e) => e.type)).toEqual([
      "tool.call",
      "tool.result",
    ]);
    expect(
      s.query({ session_id: "a", since: "2026-01-01T00:02:00Z", until: "2026-01-01T00:04:00Z" }).map((e) => e.type),
    ).toEqual(["tool.call"]);
    expect(s.query({ backend: "test" }).length).toBe(6);
    expect(s.query({ backend: "opencode" }).length).toBe(0);
    s.close();
  });

  test("text filter uses fts and orders by rank, not seq", () => {
    const s = openStore(":memory:");
    seed(s);
    const hits = s.query({ text: "auth" });
    expect(hits.length).toBe(2);
    expect(hits.every((e) => e.session_id === "a")).toBe(true);
    const none = s.query({ text: 'notacommand"; DROP TABLE events; --' });
    expect(none.length).toBe(0);
    s.close();
  });

  test("order, limit, offset", () => {
    const s = openStore(":memory:");
    seed(s);
    const desc = s.query({ session_id: "a", order: "desc" });
    expect(desc[0]!.seq).toBe(4);
    const page = s.query({ session_id: "a", order: "asc", offset: 1, limit: 2 });
    expect(page.map((e) => e.seq)).toEqual([2, 3]);
    const clamped = s.query({ session_id: "a", limit: 999_999 });
    expect(clamped.length).toBe(4);
    s.close();
  });

  test("after_seq pages a session's events from a cursor", () => {
    const s = openStore(":memory:");
    seed(s);
    const page1 = s.query({ session_id: "a", order: "asc", after_seq: 0, limit: 2 });
    expect(page1.map((e) => e.seq)).toEqual([1, 2]);
    const page2 = s.query({ session_id: "a", order: "asc", after_seq: 2, limit: 2 });
    expect(page2.map((e) => e.seq)).toEqual([3, 4]);
    expect(s.query({ session_id: "a", after_seq: 4 })).toEqual([]);
    // The cursor is a sequence number, not a row count: session b's events
    // share the seq space of their own session, never session a's.
    expect(s.query({ session_id: "b", after_seq: 1 }).map((e) => e.seq)).toEqual([2]);
    s.close();
  });

  test("empty result, no filters returns everything", () => {
    const s = openStore(":memory:");
    seed(s);
    expect(s.query({}).length).toBe(6);
    s.close();
  });

  test("stats split the record into rebuildable and local-only bytes", () => {
    const s = openStore(":memory:");
    s.append([
      mk("a", "session.started", { workspace: "/a" }),
      mk("a", "turn.user", { turn_id: "t1", content: [{ type: "text", text: "hi" }] }),
      mk("a", "permission.requested", {
        request_id: "p1",
        session_id: "a",
        tool: "bash",
        input: { command: "ls" },
        asked_at: new Date().toISOString(),
      } as never),
      mk("a", "question.asked", {
        request_id: "q1",
        questions: [],
        asked_at: new Date().toISOString(),
      } as never),
    ]);
    const stats = s.stats();
    expect(stats.sessions).toBe(1);
    expect(stats.events).toBe(4);
    expect(stats.fts).toBeGreaterThan(0);
    expect(stats.rebuildable.events).toBe(2);
    expect(stats.local.events).toBe(2);
    expect(stats.rebuildable.bytes).toBeGreaterThan(0);

    const [row] = s.classCounts(["a"]);
    expect(row).toMatchObject({ session_id: "a", rebuildable: 2, local: 2 });
    expect(row!.local_bytes).toBeGreaterThan(0);
    s.close();
  });

  test("deleting only rebuildable events keeps the facts strata alone saw", () => {
    const s = openStore(":memory:");
    s.append([
      mk("a", "session.started", { workspace: "/a" }),
      mk("a", "turn.user", { turn_id: "t1", content: [] }),
      mk("a", "permission.requested", {
        request_id: "p1",
        session_id: "a",
        tool: "bash",
        input: { command: "ls" },
        asked_at: new Date().toISOString(),
      } as never),
    ]);
    expect(s.deleteRebuildable(["a"])).toBe(2);
    expect(s.read({ session_id: "a" }).map((e) => e.type)).toEqual(["permission.requested"]);
    expect(s.listSessions()).toHaveLength(1);
    expect(s.classCounts(["a"])[0]).toMatchObject({ rebuildable: 0, local: 1 });
    s.close();
  });

  test("deleting rebuildable events removes a cache-only session entirely", () => {
    const s = openStore(":memory:");
    s.append([
      mk("b", "session.started", { workspace: "/b" }),
      mk("b", "turn.user", { turn_id: "t1", content: [] }),
    ]);
    expect(s.deleteRebuildable(["b"])).toBe(2);
    expect(s.read({ session_id: "b" })).toHaveLength(0);
    expect(s.listSessions()).toHaveLength(0);
    expect(s.stats().sessions).toBe(0);
    s.close();
  });

  test("deleting a session removes its events, row, revision and search hits", () => {
    const s = openStore(":memory:");
    s.append([
      mk("a", "session.started", { workspace: "/a" }),
      mk("a", "turn.user", { turn_id: "t1", content: [{ type: "text", text: "needle" }] }),
    ]);
    s.markRevision("a", 42);
    expect(s.search("needle")).toHaveLength(1);
    expect(s.deleteSessions(["a"])).toBe(2);
    expect(s.read({ session_id: "a" })).toHaveLength(0);
    expect(s.listSessions()).toHaveLength(0);
    expect(s.sessionRevision("a")).toBeNull();
    expect(s.search("needle")).toHaveLength(0);
    s.close();
  });

  /**
   * A store written before the segmentation change holds the old single-token
   * Chinese text, and `CREATE TABLE IF NOT EXISTS` would leave it that way — the
   * feature would work on a fresh database and be silently broken on every
   * existing one.
   *
   * The rebuild is deliberately not in `openStore`: it took 14 s on a large
   * store, and opening the database happens before the window is shown. Opening
   * reports the work; `reindex` does it.
   */
  test("an old store reports pending work and gains Chinese search when reindexed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-strata-fts-"));
    const path = join(dir, "db.sqlite");
    try {
      const first = openStore(path);
      first.append([
        mk("a", "turn.assistant", {
          turn_id: "t",
          content: [{ type: "text", text: "当前的全文搜索不支持中文" }],
        }),
      ]);
      first.close();

      // Put the database back into the pre-change state: the unsegmented text
      // and no marker saying otherwise. This is what every existing install has.
      const raw = new Database(path);
      raw.exec("DELETE FROM events_fts");
      raw.exec("DELETE FROM store_meta");
      const row = raw
        .query("SELECT id, session_id, body FROM events")
        .get() as { id: string; session_id: string; body: string };
      raw
        .query("INSERT INTO events_fts(event_id,session_id,text) VALUES(?,?,?)")
        .run(row.id, row.session_id, "当前的全文搜索不支持中文");
      // Prove the premise: the old index cannot answer a two-character word.
      const before = raw
        .query("SELECT count(*) c FROM events_fts WHERE events_fts MATCH ?")
        .get('"搜索"') as { c: number };
      expect(before.c).toBe(0);
      raw.close();

      const second = openStore(path);
      // Opening must not have done the work — that is what keeps startup fast.
      expect(second.reindexPending()).toBe(true);
      expect(second.search("搜索").length).toBe(0);

      await second.reindex();
      expect(second.reindexPending()).toBe(false);
      expect(second.reindexing()).toBe(false);
      expect(second.search("搜索").length).toBe(1);
      expect(second.search("中文").length).toBe(1);
      // A second call is a no-op, not a second rebuild.
      await second.reindex();
      expect(second.search("搜索").length).toBe(1);
      second.close();

      // The marker is durable: reopening does not ask for the work again.
      const third = openStore(path);
      expect(third.reindexPending()).toBe(false);
      expect(third.search("搜索").length).toBe(1);
      third.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The rebuild must not stop the world.
   *
   * `reindex` used to be one synchronous transaction. On a 300k-event store
   * that held the event loop for 18.6 s: no HTTP request, no stream frame, no
   * plugin callback was served for the whole of it. Deferring the call with
   * `setTimeout` moved the start, not the work.
   *
   * A timer is the witness. If the loop keeps turning, ticks keep arriving
   * between chunks; if a single transaction swallows the whole rebuild, the
   * tick count collapses. The threshold is loose on purpose — this asserts
   * "the loop still runs", not a performance figure, so it cannot flake on a
   * loaded CI machine.
   */
  test("a rebuild yields to the event loop instead of stalling it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-strata-yield-"));
    const path = join(dir, "db.sqlite");
    try {
      const seed = openStore(path);
      const batch: EventInput[] = [];
      // Enough rows that a single unchunked transaction would be plainly
      // visible; the chunk size is 500, so this spans several.
      for (let i = 0; i < 2000; i++) {
        batch.push(
          mk("a", "turn.assistant", {
            turn_id: `t${i}`,
            content: [{ type: "text", text: "当前的全文搜索不支持中文，需要修复这个问题。" }],
          }),
        );
      }
      seed.append(batch);
      seed.close();

      const raw = new Database(path);
      raw.exec("DELETE FROM store_meta");
      raw.close();

      const s = openStore(path);
      expect(s.reindexPending()).toBe(true);

      let ticks = 0;
      const timer = setInterval(() => ticks++, 1);
      await s.reindex();
      clearInterval(timer);

      expect(s.reindexPending()).toBe(false);
      // Several chunks ran, so several yield points existed. At least some
      // ticks must have been delivered — a single blocking transaction
      // delivers none.
      expect(ticks).toBeGreaterThan(0);
      expect(s.search("搜索").length).toBeGreaterThan(0);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Every row must be indexed, including across many sessions.
   *
   * The first paged version of this walked the events by `seq`, which is not a
   * global ordering — it counts within a session. On a store of 1000 sessions
   * that cursor skipped whole swathes: 300k rows came out as 75k indexed, and
   * the marker was written anyway, so the missing rows looked like "no match"
   * rather than a broken index. The page is keyed on `rowid`.
   */
  test("a rebuild indexes every row across many sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-strata-many-"));
    const path = join(dir, "db.sqlite");
    try {
      const seed = openStore(path);
      const batch: EventInput[] = [];
      // Enough sessions that per-session `seq` values repeat many times, which
      // is what made the bad cursor skip rows.
      for (let i = 0; i < 3000; i++) {
        batch.push(
          mk(`ses_${i % 120}`, "turn.assistant", {
            turn_id: `t${i}`,
            content: [{ type: "text", text: `第${i}条全文搜索的内容` }],
          }),
        );
      }
      seed.append(batch);
      seed.close();

      const raw = new Database(path);
      const before = (raw.query("SELECT count(*) c FROM events").get() as { c: number }).c;
      raw.exec("DELETE FROM store_meta");
      raw.close();
      expect(before).toBe(3000);

      const s = openStore(path);
      await s.reindex();

      const check = new Database(path);
      const indexed = (check.query("SELECT count(*) c FROM events_fts").get() as { c: number }).c;
      check.close();
      // One row per event, none skipped.
      expect(indexed).toBe(before);
      expect(s.reindexPending()).toBe(false);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A rebuild that is interrupted leaves the marker absent, so the next open
   * tries again rather than trusting a half-filled index.
   */
  test("an interrupted rebuild is retried, not accepted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-strata-half-"));
    const path = join(dir, "db.sqlite");
    try {
      const first = openStore(path);
      first.append([
        mk("a", "turn.assistant", {
          turn_id: "t",
          content: [{ type: "text", text: "当前的全文搜索不支持中文" }],
        }),
      ]);
      first.close();

      // A store whose rows are unsegmented and whose marker is missing, with a
      // partly-filled index standing in for a run that was killed midway.
      const raw = new Database(path);
      raw.exec("DELETE FROM events_fts");
      raw.exec("DELETE FROM store_meta");
      raw.close();

      const second = openStore(path);
      expect(second.reindexPending()).toBe(true);
      await second.reindex();
      expect(second.reindexPending()).toBe(false);
      expect(second.search("搜索").length).toBe(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * Two callers must not rebuild at once: the second would start by deleting
   * the rows the first is filling.
   */
  test("a second reindex joins the run in flight", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-strata-join-"));
    const path = join(dir, "db.sqlite");
    try {
      const seed = openStore(path);
      const batch: EventInput[] = [];
      for (let i = 0; i < 1200; i++) {
        batch.push(
          mk("a", "turn.assistant", {
            turn_id: `t${i}`,
            content: [{ type: "text", text: "全文搜索需要中文分词" }],
          }),
        );
      }
      seed.append(batch);
      seed.close();

      const raw = new Database(path);
      raw.exec("DELETE FROM store_meta");
      raw.close();

      const s = openStore(path);
      const first = s.reindex();
      expect(s.reindexing()).toBe(true);
      const second = s.reindex();
      await Promise.all([first, second]);

      expect(s.reindexing()).toBe(false);
      expect(s.reindexPending()).toBe(false);
      // Every row indexed exactly once — a second concurrent pass would have
      // wiped the first one's work, and a doubled insert would show here.
      const hits = s.search("分词", { limit: 5000 });
      expect(hits.length).toBe(1200);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * An event whose writer supplied no timestamp must not claim the clock.
   *
   * An import replays a session's whole history at once. If each replayed
   * event is stamped with the moment of the replay, every imported session
   * reads as having been active at import time — and since the sidebar orders
   * by that stamp, the list order becomes import order. Subagent sessions are
   * imported after their roots, so they sort first; the page filled with them,
   * the sidebar drops children, and a store with hundreds of sessions rendered
   * as an empty list.
   */
  test("an event with no source clock does not take the wall clock", () => {
    const s = openStore(":memory:");
    const before = Date.now();
    s.append([
      {
        id: "e1",
        session_id: "a",
        source: { backend: "test" },
        type: "session.started",
        data: { workspace: "/repo" },
      } as unknown as EventInput,
    ]);
    const stored = s.read({ session_id: "a" })[0]!;
    // Stamped, because the column is not nullable — but not with "now".
    expect(stored.ts).toBeDefined();
    expect(Date.parse(stored.ts)).toBeLessThan(before);
    s.close();
  });

  /**
   * The sidebar's query has to count roots, not all sessions.
   *
   * `rootsOnly` applies the filter before the limit. Without it a page can be
   * entirely subagent sessions, which the client then drops — an empty list
   * over a non-empty store.
   */
  test("listSessions can page over root sessions only", () => {
    const s = openStore(":memory:");
    const events: EventInput[] = [];
    for (let r = 0; r < 5; r++) {
      events.push(
        mk(`root_${r}`, "session.started", { workspace: "/repo" }),
      );
      for (let k = 0; k < 10; k++) {
        events.push(
          mk(`sub_${r}_${k}`, "session.started", {
            workspace: "/repo",
            parent_session_id: `root_${r}`,
          }),
        );
      }
    }
    s.append(events);

    const all = s.listSessions({ limit: 10 });
    expect(all.length).toBe(10);
    const roots = s.listSessions({ limit: 10, rootsOnly: true });
    // All five roots fit, and the limit counts them rather than the children.
    expect(roots.length).toBe(5);
    expect(roots.every((r) => !r.session_id.startsWith("sub_"))).toBe(true);
    s.close();
  });

  test("a fresh store needs no rebuild", async () => {
    const s = openStore(":memory:");
    expect(s.reindexPending()).toBe(false);
    expect(s.reindexing()).toBe(false);
    await s.reindex();
    expect(s.reindexing()).toBe(false);
    s.close();
  });

  test("a backup opens as a store and integrity/optimize/vacuum do not throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-store-"));
    try {
      const s = openStore(join(dir, "events.db"));
      s.append([mk("a", "session.started", { workspace: "/a" })]);
      expect(s.integrityCheck()).toContain("ok");
      s.optimize();
      s.vacuum();
      const copy = join(dir, "backup.db");
      s.backupTo(copy);
      expect(existsSync(copy)).toBe(true);
      const restored = openStore(copy);
      expect(restored.listSessions()).toHaveLength(1);
      restored.close();
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session revision survives reopen and keeps the newest mark", () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-store-"));
    try {
      const path = join(dir, "events.db");
      const s1 = openStore(path);
      expect(s1.sessionRevision("opencode:ses_1")).toBeNull();
      s1.markRevision("opencode:ses_1", 1000);
      s1.markRevision("opencode:ses_1", 2000);
      s1.close();
      const s2 = openStore(path);
      expect(s2.sessionRevision("opencode:ses_1")).toBe(2000);
      expect(s2.sessionRevision("opencode:ses_2")).toBeNull();
      s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * The question a driver asks when it connects: is anything still running?
   *
   * A run cut off by closing the app leaves `busy` in the projection and
   * nothing after it, so the answer is "yes" for a session that has been
   * nothing but idle since. Reading it from the store rather than from the
   * driver's own ledger is the whole point — the ledger does not survive the
   * restart that left the state stale.
   */
  test("a session is running until an ending is the last word", () => {
    const s = openStore(":memory:");
    s.append([mk("opencode:ses_1", "session.started", { workspace: "/repo" }, "2026-01-01T00:00:00.000Z")]);
    s.append([mk("opencode:ses_1", "session.status", { state: "busy" }, "2026-01-01T00:00:01.000Z")]);
    expect(s.sessionRunning("opencode:ses_1").running).toBe(true);

    s.append([mk("opencode:ses_1", "session.status", { state: "idle" }, "2026-01-01T00:00:02.000Z")]);
    expect(s.sessionRunning("opencode:ses_1").running).toBe(false);

    // `retry` and `compacting` are still a run in progress, not an ending.
    s.append([mk("opencode:ses_1", "session.status", { state: "retry" }, "2026-01-01T00:00:03.000Z")]);
    expect(s.sessionRunning("opencode:ses_1").running).toBe(true);

    s.append([
      mk("opencode:ses_1", "session.ended", { reason: "completed" }, "2026-01-01T00:00:04.000Z"),
    ]);
    expect(s.sessionRunning("opencode:ses_1").running).toBe(false);
    s.close();
  });

  test("an ending of any kind clears it, and an unknown session is not running", () => {
    const s = openStore(":memory:");
    expect(s.sessionRunning("opencode:nope")).toEqual({ running: false, seq: 0 });

    s.append([mk("opencode:ses_2", "session.started", { workspace: "/repo" })]);
    s.append([mk("opencode:ses_2", "session.status", { state: "busy" })]);
    expect(s.sessionRunning("opencode:ses_2").running).toBe(true);
    s.append([mk("opencode:ses_2", "session.error", { error: { message: "boom" } })]);
    expect(s.sessionRunning("opencode:ses_2").running).toBe(false);
    s.close();
  });
});

describe("running sessions, asked of the whole store at once", () => {
  /**
   * The bulk answer has to agree with the single-session one, exactly.
   *
   * A correction at connect time uses this to decide what to rewrite, and the
   * two must never disagree: the per-session answer is what every other caller
   * reads, so a bulk query that drifted would correct sessions that are fine
   * and leave the ones that are not.
   */
  test("agrees with sessionRunning for every session in the store", () => {
    const s = openStore(":memory:");
    s.append([mk("opencode:busy", "session.started", { workspace: "/repo" })]);
    s.append([mk("opencode:busy", "session.status", { state: "busy" })]);

    s.append([mk("opencode:idle", "session.started", { workspace: "/other" })]);
    s.append([mk("opencode:idle", "session.status", { state: "busy" })]);
    s.append([mk("opencode:idle", "session.status", { state: "idle" })]);

    s.append([mk("opencode:ended", "session.started", { workspace: "/repo" })]);
    s.append([mk("opencode:ended", "session.status", { state: "busy" })]);
    s.append([mk("opencode:ended", "session.ended", { reason: "completed" })]);

    s.append([mk("opencode:errored", "session.started", { workspace: "/repo" })]);
    s.append([mk("opencode:errored", "session.status", { state: "busy" })]);
    s.append([mk("opencode:errored", "session.error", { error: { message: "boom" } })]);

    // `retry` is still a run: the backend is working, just not on the reply.
    s.append([mk("opencode:retrying", "session.started", { workspace: "/repo" })]);
    s.append([mk("opencode:retrying", "session.status", { state: "retry" })]);

    // Started but never said what it is doing: nothing to correct.
    s.append([mk("opencode:quiet", "session.started", { workspace: "/repo" })]);

    const ids = [
      "opencode:busy",
      "opencode:idle",
      "opencode:ended",
      "opencode:errored",
      "opencode:retrying",
      "opencode:quiet",
    ];
    const bulk = new Map(s.runningSessions().map((row) => [row.session_id, row]));
    for (const id of ids) {
      expect({ id, running: bulk.has(id) }).toEqual({ id, running: s.sessionRunning(id).running });
    }
    expect([...bulk.keys()].sort()).toEqual(["opencode:busy", "opencode:retrying"]);
    s.close();
  });

  test("the quietest session comes first, so a capped caller reaches the stale ones", () => {
    const s = openStore(":memory:");
    s.append([mk("opencode:new", "session.started", { workspace: "/repo" }, "2026-01-03T00:00:00.000Z")]);
    s.append([mk("opencode:new", "session.status", { state: "busy" }, "2026-01-03T00:00:01.000Z")]);
    s.append([mk("opencode:old", "session.started", { workspace: "/repo" }, "2026-01-01T00:00:00.000Z")]);
    s.append([mk("opencode:old", "session.status", { state: "busy" }, "2026-01-01T00:00:01.000Z")]);

    // A caller that can only afford to check some of them wants the ones that
    // have been quiet longest: a mark that has not moved since yesterday is a
    // mark left behind, while a session that moved today may still be running.
    expect(s.runningSessions().map((row) => row.session_id)).toEqual([
      "opencode:old",
      "opencode:new",
    ]);
    s.close();
  });

  test("carries the workspace, so the answer can be compared per directory", () => {    const s = openStore(":memory:");
    s.append([mk("opencode:a", "session.started", { workspace: "D:/code/a" })]);
    s.append([mk("opencode:a", "session.status", { state: "busy" })]);
    s.append([mk("opencode:b", "session.started", { workspace: "D:/code/b" })]);
    s.append([mk("opencode:b", "session.status", { state: "busy" })]);

    const byId = new Map(s.runningSessions().map((row) => [row.session_id, row]));
    expect(byId.get("opencode:a")?.workspace).toBe("D:/code/a");
    expect(byId.get("opencode:b")?.workspace).toBe("D:/code/b");
    s.close();
  });

  test("carries the position the correction is written against", () => {
    const s = openStore(":memory:");
    s.append([mk("opencode:a", "session.started", { workspace: "/repo" })]);
    s.append([mk("opencode:a", "session.status", { state: "busy" })]);
    const row = s.runningSessions()[0]!;
    expect(row.seq).toBe(s.sessionRunning("opencode:a").seq);
    expect(row.ts).toBe(s.sessionRunning("opencode:a").ts);
    s.close();
  });

  test("carries the origin across reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-origin-"));
    const path = join(dir, "events.db");
    try {
      const first = openStore(path);
      first.append(
        [
          mk("opencode:a", "session.started", { workspace: "/repo" }),
          mk("opencode:a", "session.status", { state: "busy" }),
        ],
        { origin: "opencode:http://a", claimOrigin: true },
      );
      first.close();
      const second = openStore(path);
      expect(second.runningSessions()[0]?.origin).toBe("opencode:http://a");
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a historical read does not take an origin from live evidence", () => {
    const s = openStore(":memory:");
    s.append(
      [
        mk("opencode:a", "session.started", { workspace: "/repo" }),
        mk("opencode:a", "session.status", { state: "busy" }),
      ],
      { origin: "A", claimOrigin: true },
    );
    s.append([mk("opencode:a", "session.updated", { title: "history" })], { origin: "B" });
    expect(s.runningSessions()[0]?.origin).toBe("A");
    s.append([mk("opencode:a", "turn.user", { turn_id: "live", content: [] })], {
      origin: "B",
      claimOrigin: true,
    });
    expect(s.runningSessions()[0]?.origin).toBe("B");
    s.close();
  });

  test("an unchanged historical replay backfills only a missing origin", () => {
    const s = openStore(":memory:");
    const events = [
      mk("opencode:a", "session.started", { workspace: "/repo" }),
      mk("opencode:a", "session.status", { state: "busy" }),
    ];
    s.append(events);
    s.append(events, { origin: "A" });
    expect(s.runningSessions()[0]?.origin).toBe("A");
    s.append(events, { origin: "B" });
    expect(s.runningSessions()[0]?.origin).toBe("A");
    s.close();
  });

  test("a correction writes only sessions still at the observed position", () => {
    const s = openStore(":memory:");
    s.append([
      mk("opencode:a", "session.started", { workspace: "/repo" }),
      mk("opencode:a", "session.status", { state: "busy" }),
      mk("opencode:b", "session.started", { workspace: "/repo" }),
      mk("opencode:b", "session.status", { state: "busy" }),
    ]);
    const expected = Object.fromEntries(s.runningSessions().map((row) => [row.session_id, row.seq]));
    s.append([mk("opencode:a", "turn.user", { turn_id: "new-work", content: [] })]);
    s.append(
      [
        mk("opencode:a", "session.status", { state: "idle" }),
        mk("opencode:b", "session.status", { state: "idle" }),
      ],
      { ifUnchanged: expected },
    );
    expect(s.sessionRunning("opencode:a").running).toBe(true);
    expect(s.sessionRunning("opencode:b").running).toBe(false);
    s.close();
  });

  test("an empty store has nothing to correct", () => {
    const s = openStore(":memory:");
    expect(s.runningSessions()).toEqual([]);
    s.close();
  });
});
