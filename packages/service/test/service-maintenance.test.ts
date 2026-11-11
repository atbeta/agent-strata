import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService, type RunningService } from "../src/index";
import { ev } from "./service-harness";

describe("store maintenance", () => {
  const withFileStore = async (
    run: (ctx: { dir: string; db: string; base: string; svc: RunningService }) => Promise<void>,
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "strata-maintenance-"));
    const db = join(dir, "events.db");
    const desktopDir = join(dir, "profile");
    const svc = startService({ db, port: 0, desktopDir });
    const base = `http://127.0.0.1:${svc.port}`;
    try {
      await run({ dir, db, base, svc });
    } finally {
      svc.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const fact = (sessionId: string) =>
    ev(sessionId, "permission.requested", { request_id: "p1", tool: "bash", input: { command: "ls" } }, "2026-01-01T00:00:03Z");

  test("a session page reports whether more rows were left behind", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    for (const id of ["a", "b", "c"]) {
      svc.store.append([
        ev(`opencode:${id}`, "session.started", { title: id, workspace: `/tmp/${id}` }, `2026-01-0${id === "a" ? 1 : id === "b" ? 2 : 3}T00:00:00Z`),
      ]);
    }
    const first = await fetch(`${base}/sessions?limit=2`).then((r) => r.json());
    expect(first.sessions).toHaveLength(2);
    expect(first.more).toBe(true);
    const all = await fetch(`${base}/sessions?limit=5`).then((r) => r.json());
    expect(all.sessions).toHaveLength(3);
    expect(all.more).toBe(false);
    svc.stop();
  });

  test("the snapshot reports file sizes and the rebuildable/local split", async () => {
    await withFileStore(async ({ db, base, svc }) => {
      svc.store.append([
        ev("opencode:a", "session.started", { title: "A", workspace: "/a" }, "2026-01-01T00:00:00Z"),
        ev("opencode:a", "turn.user", { turn_id: "t1", content: [{ type: "text", text: "hello" }] }, "2026-01-01T00:00:01Z"),
        fact("opencode:a"),
      ]);
      const got = (await fetch(`${base}/maintenance`).then((r) => r.json())) as {
        db: { path: string; bytes: number; stats: Record<string, unknown> };
        backups: unknown[];
        legacy: unknown[];
      };
      expect(got.db.path).toBe(db);
      expect(got.db.bytes).toBeGreaterThan(0);
      expect(got.db.stats).toMatchObject({ sessions: 1, events: 3, rebuildable: { events: 2 }, local: { events: 1 } });
      expect(got.backups).toEqual([]);
      expect(got.legacy).toEqual([]);
    });
  });

  test("a clean previews, then removes only rebuildable events", async () => {
    await withFileStore(async ({ base, svc }) => {
      svc.store.append([
        ev("opencode:a", "session.started", { title: "A", workspace: "/a" }, "2026-01-01T00:00:00Z"),
        ev("opencode:a", "turn.user", { turn_id: "t1", content: [{ type: "text", text: "hello" }] }, "2026-01-01T00:00:01Z"),
        fact("opencode:a"),
      ]);
      const post = (body: unknown) =>
        fetch(`${base}/maintenance/clean`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then((r) => r.json());

      const preview = await post({ mode: "rebuildable", session_ids: ["opencode:a"] });
      expect(preview.applied).toBe(false);
      expect(preview.totals).toMatchObject({ sessions: 1, rebuildable: 2, local: 1 });
      expect(preview.targets[0]).toMatchObject({ title: "A", rebuildable: 2, local: 1 });

      const applied = await post({ mode: "rebuildable", session_ids: ["opencode:a"], apply: true });
      expect(applied.deleted).toBe(2);
      expect(svc.store.read({ session_id: "opencode:a" }).map((e) => e.type)).toEqual(["permission.requested"]);
      expect(svc.store.listSessions()).toHaveLength(1);
    });
  });

  test("a backup is listed and can be deleted", async () => {
    await withFileStore(async ({ base, dir, svc }) => {
      svc.store.append([ev("opencode:a", "session.started", { title: "A", workspace: "/a" }, "2026-01-01T00:00:00Z")]);
      const after = (await fetch(`${base}/maintenance/backup`, { method: "POST" }).then((r) => r.json())) as {
        backups: { name: string; bytes: number }[];
      };
      expect(after.backups).toHaveLength(1);
      const name = after.backups[0]!.name;
      expect(after.backups[0]!.bytes).toBeGreaterThan(0);
      expect(existsSync(join(dir, "backups", name))).toBe(true);

      const removed = (await fetch(`${base}/maintenance/backups/${encodeURIComponent(name)}`, { method: "DELETE" }).then((r) => r.json())) as {
        backups: unknown[];
      };
      expect(removed.backups).toEqual([]);
      expect(existsSync(join(dir, "backups", name))).toBe(false);
    });
  });

  test("session data names the two classes, and local delete needs no backend", async () => {
    await withFileStore(async ({ base, svc }) => {
      svc.store.append([
        ev("opencode:a", "session.started", { title: "A", workspace: "/a" }, "2026-01-01T00:00:00Z"),
        ev("opencode:a", "turn.user", { turn_id: "t1", content: [{ type: "text", text: "hello" }] }, "2026-01-01T00:00:01Z"),
        fact("opencode:a"),
      ]);
      const data = await fetch(`${base}/sessions/${encodeURIComponent("opencode:a")}/data`).then((r) => r.json());
      expect(data).toMatchObject({ session_id: "opencode:a", rebuildable: 2, local: 1, backend: false, can_delete: false });

      const refused = await fetch(`${base}/sessions/${encodeURIComponent("opencode:a")}`, { method: "DELETE" });
      expect(refused.status).toBe(409);
      const body = await refused.json();
      expect(body).toMatchObject({ local_only: true, local: 1 });

      const removed = await fetch(`${base}/sessions/${encodeURIComponent("opencode:a")}?local=1`, { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toMatchObject({ ok: true, backend: false, local: 1 });
      expect(svc.store.read({ session_id: "opencode:a" })).toHaveLength(0);
    });
  });

  test("legacy snapshots are visible and deletable; other names are not", async () => {
    await withFileStore(async ({ base, dir }) => {
      writeFileSync(join(dir, "events.db.bak-20260101-0000"), "old");
      const listed = (await fetch(`${base}/maintenance`).then((r) => r.json())) as { legacy: { name: string; bytes: number }[] };
      expect(listed.legacy.map((file) => file.name)).toContain("events.db.bak-20260101-0000");

      const bad = await fetch(`${base}/maintenance/legacy/events.db`, { method: "DELETE" });
      expect(bad.status).toBe(400);

      const removed = await fetch(`${base}/maintenance/legacy/${encodeURIComponent("events.db.bak-20260101-0000")}`, { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(existsSync(join(dir, "events.db.bak-20260101-0000"))).toBe(false);
    });
  });
});
