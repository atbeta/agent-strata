import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { openStore } from "@agent-strata/store";
import { startService } from "../src/index";
import { sessionOrigin } from "../src/connections";
import { fakeOpencode } from "./fake-opencode";

const at = (n: number) => `2026-01-01T00:00:0${n}.000Z`;

function seed(dbPath: string, native: string, origin: string, extra: EventInput["type"][] = []) {
  const store = openStore(dbPath);
  const session_id = `opencode:${native}`;
  const source = { backend: "opencode", native_id: native };
  const events: EventInput[] = [
    makeEvent({ id: `${native}:started`, session_id, source, type: "session.started", data: { workspace: "/repo" }, ts: at(0) } as EventInput),
    makeEvent({ id: `${native}:updated`, session_id, source, type: "session.updated", data: { title: native, workspace: "/repo" }, ts: at(1) } as EventInput),
  ];
  extra.forEach((type, index) => {
    events.push(makeEvent({ id: `${native}:${type}`, session_id, source, type, data: {}, ts: at(2 + index) } as EventInput));
  });
  store.append(events, { origin, claimOrigin: true });
  store.close();
}

async function connected(base: string, server: ReturnType<typeof fakeOpencode>) {
  const res = await fetch(`${base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: server.baseUrl, placement: "external" }),
  });
  expect(res.status).toBe(200);
  // The connect indexes once and the sync crawls again; the reconcile pass
  // runs after the second listing, so wait for that sync to settle.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const listings = server.seen.filter((row) => row.path === "/experimental/session").length;
    const body = (await fetch(`${base}/connections`).then((r) => r.json())) as { connections: { sync?: string }[] };
    if (listings >= 2 && body.connections.every((conn) => conn.sync === "idle")) break;
    await Bun.sleep(20);
  }
  await Bun.sleep(100);
}

async function row(base: string, sessionId: string) {
  const body = (await fetch(`${base}/sessions?roots=1`).then((r) => r.json())) as {
    sessions: { summary: { session_id: string }; deleted?: boolean }[];
  };
  return body.sessions.find((entry) => entry.summary.session_id === sessionId);
}

describe("a sync reconciles only the sessions its own server holds", () => {
  test("a server that never held a session does not mark it deleted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-sync-scope-"));
    const db = join(dir, "events.db");
    // The session came from the reader's local engine; only a remote server
    // is connected now. The remote 404s it — of course it does, it never
    // had it — and that is not evidence of a delete.
    seed(db, "ses_local", sessionOrigin({ baseUrl: "http://127.0.0.1:4096", placement: "embed" }, "gen-1"));
    const remote = fakeOpencode({
      "/session": () => Response.json([{ id: "ses_remote", directory: "/srv", title: "remote", time: { created: 1, updated: 2 } }]),
      "/session/ses_remote": () => Response.json({ id: "ses_remote", directory: "/srv", title: "remote", time: { created: 1, updated: 2 } }),
      "/session/ses_remote/message": () => Response.json([]),
    });
    const svc = startService({ db, port: 0, desktopDir: dir });
    const base = `http://127.0.0.1:${svc.port}`;
    try {
      await connected(base, remote);
      expect(remote.seen.some((entry) => entry.path === "/session/ses_local")).toBe(false);
      expect(svc.store.deletedSessions()).not.toContain("opencode:ses_local");
      expect((await row(base, "opencode:ses_local"))?.deleted).toBe(false);
    } finally {
      svc.stop();
      remote.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the session's own server still 404ing it is a delete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-sync-scope-"));
    const db = join(dir, "events.db");
    // An empty listing alone proves nothing, so the server lists one session
    // and answers 404 for the one it no longer has.
    const kept = { id: "ses_kept", directory: "/repo", title: "kept", time: { created: 1, updated: 2 } };
    const owner = fakeOpencode({
      "/session": () => Response.json([kept]),
      "/session/ses_kept": () => Response.json(kept),
      "/session/ses_kept/message": () => Response.json([]),
    });
    seed(db, "ses_gone", sessionOrigin({ baseUrl: owner.baseUrl, placement: "external" }));
    const svc = startService({ db, port: 0, desktopDir: dir });
    const base = `http://127.0.0.1:${svc.port}`;
    try {
      await connected(base, owner);
      expect(owner.seen.some((entry) => entry.path === "/session/ses_gone")).toBe(true);
      expect(svc.store.deletedSessions()).toContain("opencode:ses_gone");
    } finally {
      svc.stop();
      owner.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a session its own server still lists comes back from a second-hand delete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-sync-scope-"));
    const db = join(dir, "events.db");
    const info = { id: "ses_back", directory: "/repo", title: "ses_back", time: { created: 1, updated: 2 } };
    const owner = fakeOpencode({
      "/session": () => Response.json([info]),
      "/session/ses_back": () => Response.json(info),
      "/session/ses_back/message": () => Response.json([]),
    });
    // An earlier sync against another server wrote the delete: the store
    // heard it second-hand, and the server that holds the session disagrees.
    seed(db, "ses_back", sessionOrigin({ baseUrl: owner.baseUrl, placement: "external" }), ["session.deleted"]);
    const svc = startService({ db, port: 0, desktopDir: dir });
    const base = `http://127.0.0.1:${svc.port}`;
    try {
      expect((await row(base, "opencode:ses_back"))?.deleted).toBe(true);
      await connected(base, owner);
      expect((await row(base, "opencode:ses_back"))?.deleted).toBe(false);
      expect(svc.store.deletedSessions()).not.toContain("opencode:ses_back");
      // and a second sync has nothing more to undo
      const before = svc.store.lastSeq("opencode:ses_back");
      await fetch(`${base}/sync`, { method: "POST" });
      await Bun.sleep(200);
      expect(svc.store.lastSeq("opencode:ses_back")).toBe(before);
    } finally {
      svc.stop();
      owner.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
