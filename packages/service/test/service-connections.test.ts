import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { openStore } from "@agent-strata/store";
import { startService } from "../src/index";
import { sessionOrigin } from "../src/connections";
import { fakeOpencode } from "./fake-opencode";

describe("connection lifecycle routes", () => {
  test("a backend that is gone on boot is reported for opencode and acp alike", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-boot-gone-"));
    writeFileSync(join(dir, "connections.json"), JSON.stringify([
      { baseUrl: "http://127.0.0.1:1" },
      { backend: "acp", command: "strata-no-such-agent", args: ["--nope"] },
    ]) + "\n");
    const svc = startService({ db: join(dir, "events.db"), port: 0, desktopDir: dir, autoConnectTimeoutMs: -1 });
    const base = `http://127.0.0.1:${svc.port}`;
    let body = { phase: "", attempts: [] as { endpoint: string; phase: string; backend: string }[] };
    for (let i = 0; i < 80; i++) {
      body = (await fetch(`${base}/connections`).then((r) => r.json())) as typeof body;
      if (body.phase === "failed" && body.attempts.length >= 2 && body.attempts.every((a) => a.phase === "failed")) break;
      await Bun.sleep(50);
    }
    expect(body.phase).toBe("failed");
    expect(body.attempts.map((a) => a.endpoint).sort()).toEqual(["acp://strata-no-such-agent --nope", "http://127.0.0.1:1"]);
    expect(body.attempts.map((a) => a.backend).sort()).toEqual(["acp", "opencode"]);
    svc.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("forgetting a dead backend keeps it from being dialed again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-boot-forget-"));
    writeFileSync(join(dir, "connections.json"), JSON.stringify([
      { baseUrl: "http://127.0.0.1:1" },
      { backend: "acp", command: "strata-no-such-agent", args: ["--nope"] },
    ]) + "\n");
    const db = join(dir, "events.db");
    const first = startService({ db, port: 0, desktopDir: dir, autoConnectTimeoutMs: -1 });
    const base = `http://127.0.0.1:${first.port}`;
    let phase = "";
    for (let i = 0; i < 80 && phase !== "failed"; i++) {
      phase = ((await fetch(`${base}/connections`).then((r) => r.json())) as { phase: string }).phase;
      if (phase !== "failed") await Bun.sleep(50);
    }
    expect(phase).toBe("failed");
    for (const endpoint of ["http://127.0.0.1:1", "acp://strata-no-such-agent --nope"]) {
      const res = await fetch(`${base}/connections/forget`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      expect(res.status).toBe(200);
    }
    const after = (await fetch(`${base}/connections`).then((r) => r.json())) as { phase: string; attempts: unknown[] };
    expect(after.attempts).toEqual([]);
    expect(after.phase).toBe("idle");
    expect(JSON.parse(readFileSync(join(dir, "connections.json"), "utf8"))).toEqual([]);
    first.stop();
    const second = startService({ db, port: 0, desktopDir: dir, autoConnectTimeoutMs: -1 });
    const again = (await fetch(`http://127.0.0.1:${second.port}/connections`).then((r) => r.json())) as { phase: string; attempts: unknown[] };
    expect(again.phase).toBe("idle");
    expect(again.attempts).toEqual([]);
    second.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a shorter reconnect does not report the boot target dead while boot is still trying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-boot-hold-"));
    writeFileSync(join(dir, "connections.json"), JSON.stringify([
      { backend: "acp", command: "strata-no-such-agent", args: ["--nope"] },
    ]) + "\n");
    const svc = startService({ db: join(dir, "events.db"), port: 0, desktopDir: dir, autoConnectTimeoutMs: 5_000 });
    const base = `http://127.0.0.1:${svc.port}`;
    expect((await fetch(`${base}/sync`, { method: "POST" })).status).toBe(200);
    const body = (await fetch(`${base}/connections`).then((r) => r.json())) as {
      phase: string;
      attempts: { phase: string; endpoint: string }[];
    };
    expect(body.phase).toBe("attaching");
    expect(body.attempts).toEqual([
      expect.objectContaining({ endpoint: "acp://strata-no-such-agent --nope", phase: "retrying" }),
    ]);
    svc.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an opencode connection says whether it is the embedded server", async () => {
    const oc = fakeOpencode();
    const desktopDir = mkdtempSync(join(tmpdir(), "strata-placement-"));
    writeFileSync(join(desktopDir, "opencode-status.json"), JSON.stringify({ state: "running", url: oc.baseUrl }));
    const svc = startService({ db: ":memory:", port: 0, desktopDir });
    const base = `http://127.0.0.1:${svc.port}`;
    const connected = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl }),
    });
    expect(connected.status).toBe(200);
    const embedded = (await fetch(`${base}/connections`).then((r) => r.json())) as {
      phase: string;
      connections: { placement?: string; baseUrl: string }[];
    };
    expect(embedded.phase).toBe("connected");
    expect(embedded.connections[0]).toMatchObject({ baseUrl: oc.baseUrl, placement: "embed" });
    writeFileSync(join(desktopDir, "desktop.json"), JSON.stringify({ opencode: "external" }));
    const external = (await fetch(`${base}/connections`).then((r) => r.json())) as { connections: { placement?: string }[] };
    expect(external.connections[0]?.placement).toBe("external");
    writeFileSync(join(desktopDir, "desktop.json"), JSON.stringify({ opencode: "embed" }));
    writeFileSync(join(desktopDir, "opencode-status.json"), JSON.stringify({ state: "running", url: "http://127.0.0.1:9" }));
    const other = (await fetch(`${base}/connections`).then((r) => r.json())) as { connections: { placement?: string }[] };
    expect(other.connections[0]?.placement).toBe("external");
    svc.stop();
    oc.stop();
    rmSync(desktopDir, { recursive: true, force: true });
  });

  test("autoConnect to a dead backend retries then gives up, service stays up", async () => {
    const svc = startService({
      db: ":memory:", port: 0, autoConnect: "http://127.0.0.1:1", autoConnectTimeoutMs: 400,
    });
    await Bun.sleep(600);
    const health = await fetch(`http://127.0.0.1:${svc.port}/health`).then((r) => r.json());
    expect(health.ok).toBe(true);
    expect(health.conns).toBe(0);
    svc.stop();
  });

  test("the embedded server of an earlier run is neither dialed nor remembered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-embed-boot-"));
    const stale = (port: number) => ({
      baseUrl: `http://127.0.0.1:${port}`,
      username: "opencode",
      password: "yachwVpceU13FftYteC9pU7Hq448RciEEgmflAWueNI",
    });
    writeFileSync(join(dir, "connections.json"), JSON.stringify([
      stale(53507), stale(51800), { baseUrl: "http://127.0.0.1:4096" },
    ]) + "\n");
    const svc = startService({
      db: join(dir, "events.db"), port: 0, desktopDir: dir,
      autoConnect: "http://127.0.0.1:64091", autoConnectPlacement: "embed", autoConnectTimeoutMs: -1,
    });
    const base = `http://127.0.0.1:${svc.port}`;
    let body = { attempts: [] as { endpoint: string }[] };
    for (let i = 0; i < 80; i++) {
      body = (await fetch(`${base}/connections`).then((r) => r.json())) as typeof body;
      const endpoints = body.attempts.map((a) => a.endpoint);
      if (endpoints.includes("http://127.0.0.1:64091") && !endpoints.includes("http://127.0.0.1:53507")) break;
      await Bun.sleep(50);
    }
    expect(body.attempts.map((a) => a.endpoint).sort()).toEqual(["http://127.0.0.1:4096", "http://127.0.0.1:64091"]);
    const saved = JSON.parse(readFileSync(join(dir, "connections.json"), "utf8")) as { baseUrl: string }[];
    expect(saved.map((c) => c.baseUrl)).toEqual(["http://127.0.0.1:4096"]);
    svc.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an address of the app's own shape that answers is kept", async () => {
    const oc = fakeOpencode();
    const dir = mkdtempSync(join(tmpdir(), "strata-embed-live-"));
    writeFileSync(join(dir, "connections.json"), JSON.stringify([
      { baseUrl: oc.baseUrl, username: "opencode", password: "yachwVpceU13FftYteC9pU7Hq448RciEEgmflAWueNI" },
    ]) + "\n");
    const svc = startService({ db: join(dir, "events.db"), port: 0, desktopDir: dir, autoConnectTimeoutMs: -1 });
    const base = `http://127.0.0.1:${svc.port}`;
    let conns = 0;
    for (let i = 0; i < 80 && conns === 0; i++) {
      conns = (await fetch(`${base}/health`).then((r) => r.json())).conns;
      if (conns === 0) await Bun.sleep(50);
    }
    expect(conns).toBe(1);
    const saved = JSON.parse(readFileSync(join(dir, "connections.json"), "utf8")) as { baseUrl: string }[];
    expect(saved.map((c) => c.baseUrl)).toEqual([oc.baseUrl]);
    svc.stop();
    oc.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a launch replaces the embedded address instead of adding one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-embed-again-"));
    const db = join(dir, "events.db");
    const first = fakeOpencode();
    const second = fakeOpencode();
    const boot = async (url: string) => {
      const svc = startService({
        db, port: 0, desktopDir: dir, autoConnect: url, autoConnectPlacement: "embed", autoConnectTimeoutMs: -1,
      });
      for (let i = 0; i < 80; i++) {
        const health = (await fetch(`http://127.0.0.1:${svc.port}/health`).then((r) => r.json())) as { conns: number };
        if (health.conns > 0) break;
        await Bun.sleep(50);
      }
      svc.stop();
    };
    await boot(first.baseUrl);
    await boot(second.baseUrl);
    const saved = JSON.parse(readFileSync(join(dir, "connections.json"), "utf8")) as { baseUrl?: string; placement?: string }[];
    expect(saved).toHaveLength(1);
    expect(saved[0]?.baseUrl).toBe(second.baseUrl);
    expect(saved[0]?.placement).toBe("embed");
    first.stop();
    second.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a remembered dead address does not block the live one", async () => {
    const oc = fakeOpencode();
    const dir = mkdtempSync(join(tmpdir(), "strata-boot-"));
    writeFileSync(join(dir, "connections.json"), JSON.stringify([
      { baseUrl: "http://127.0.0.1:1" }, { baseUrl: oc.baseUrl },
    ]) + "\n");
    const svc = startService({ db: join(dir, "events.db"), port: 0, autoConnectTimeoutMs: 2_000 });
    const base = `http://127.0.0.1:${svc.port}`;
    const started = Date.now();
    let conns = 0;
    while (Date.now() - started < 2_000) {
      conns = ((await fetch(`${base}/health`).then((r) => r.json())) as { conns: number }).conns;
      if (conns >= 1) break;
      await Bun.sleep(50);
    }
    expect(conns).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_500);
    svc.stop();
    oc.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("external servers sharing a session record do not clear each other's running mark", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-external-origin-"));
    writeFileSync(join(dir, "desktop.json"), JSON.stringify({ opencode: "external" }));
    const other = fakeOpencode({
      "/session": () => Response.json([
        { id: "ses_shared", directory: "/repo", title: "shared", time: { created: 1, updated: 30 } },
      ]),
      "/session/ses_shared": () => Response.json({ id: "ses_shared", directory: "/repo" }),
      "/session/status": () => Response.json({}),
    });
    const owner = fakeOpencode({
      "/session": () => Response.json([
        { id: "ses_shared", directory: "/repo", title: "shared", time: { created: 1, updated: 20 } },
      ]),
      "/session/ses_shared": () => Response.json({ id: "ses_shared", directory: "/repo" }),
      "/session/status": () => Response.json({ ses_shared: { type: "busy" } }),
    });
    const originA = sessionOrigin({ baseUrl: owner.baseUrl, placement: "external" });
    const store = openStore(join(dir, "events.db"));
    store.append(
      [
        makeEvent({
          id: "shared:started",
          session_id: "opencode:ses_shared",
          source: { backend: "opencode", native_id: "ses_shared" },
          type: "session.started",
          data: { workspace: "/repo" },
          ts: "2026-01-01T00:00:00.000Z",
        } as EventInput),
        makeEvent({
          id: "shared:busy",
          session_id: "opencode:ses_shared",
          source: { backend: "opencode", native_id: "ses_shared" },
          type: "session.status",
          data: { state: "busy" },
          ts: "2026-01-01T00:00:01.000Z",
        } as EventInput),
      ],
      { origin: originA, claimOrigin: true },
    );
    store.close();
    const svc = startService({ db: join(dir, "events.db"), port: 0, desktopDir: dir });
    const base = `http://127.0.0.1:${svc.port}`;
    try {
      const connect = async (server: ReturnType<typeof fakeOpencode>) => {
        const connected = await fetch(`${base}/connect`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ baseUrl: server.baseUrl, placement: "external" }),
        });
        expect(connected.status).toBe(200);
      };
      await connect(owner);
      await connect(other);
      const deadline = Date.now() + 4_000;
      while (other.seen.filter((row) => row.path === "/experimental/session").length < 2 && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      expect(svc.store.runningSessions().find((row) => row.session_id === "opencode:ses_shared")?.origin).toBe(originA);
      await fetch(`${base}/connections/${encodeURIComponent(`opencode:${other.baseUrl}`)}`, { method: "DELETE" });
      await connect(other);
      while (!owner.seen.some((row) => row.path === "/session/status") && Date.now() < deadline) {
        await Bun.sleep(20);
      }
      const body = (await fetch(`${base}/sessions`).then((r) => r.json())) as {
        sessions: { summary: { session_id: string }; busy: boolean }[];
      };
      expect(body.sessions.find((row) => row.summary.session_id === "opencode:ses_shared")?.busy).toBe(true);
      expect(other.seen.some((row) => row.path === "/session/status")).toBe(false);
      expect(owner.seen.some((row) => row.path === "/session/status")).toBe(true);
    } finally {
      svc.stop();
      other.stop();
      owner.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("/connections says starting, then syncing, then idle as a connect's sync brings a session", async () => {
    const gate = () => {
      let open = false;
      const waiters: (() => void)[] = [];
      return {
        hold: async () => {
          if (!open) await new Promise<void>((resolve) => waiters.push(resolve));
        },
        release: () => {
          open = true;
          for (const resolve of waiters.splice(0)) resolve();
        },
      };
    };
    const sessions = gate();
    const children = gate();
    const info = { id: "ses_new", title: "new", directory: "/repo", time: { created: 1, updated: 2 } };
    // The connect's index sees nothing; the sync's crawl then finds a session
    // the store has never held, which is a change the reader will see.
    let listed = 0;
    const oc = fakeOpencode({
      "/session": async () => {
        await sessions.hold();
        listed += 1;
        return Response.json(listed === 1 ? [] : [info]);
      },
      "/session/ses_new/children": async () => {
        await children.hold();
        return Response.json([]);
      },
      "/session/ses_new": () => Response.json(info),
      "/session/ses_new/message": () => Response.json([]),
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const conn = async () =>
      ((await fetch(`${base}/connections`).then((r) => r.json())) as {
        connections: { backend?: string; sync?: string; syncDone?: number; syncTotal?: number }[];
      }).connections[0];
    const until = async (want: string) => {
      let seen;
      for (let i = 0; i < 200; i++) {
        seen = await conn();
        if (seen?.sync === want) return seen;
        await Bun.sleep(20);
      }
      return seen;
    };
    const connecting = fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl }),
    }).then((r) => r.json());
    const starting = await until("starting");
    expect(starting).toMatchObject({ backend: "opencode", sync: "starting" });
    expect(starting?.syncDone).toBeUndefined();
    expect(starting?.syncTotal).toBeUndefined();
    sessions.release();
    const connected = await connecting;
    expect(connected.id).toStartWith("opencode:");
    const syncing = await until("syncing");
    expect(syncing).toMatchObject({ sync: "syncing", syncDone: 0, syncTotal: 0 });
    children.release();
    const idle = await until("idle");
    expect(idle?.sync).toBe("idle");
    expect(idle?.syncDone).toBeUndefined();
    oc.stop();
    svc.stop();
  });

  test("a sync that finds nothing new is never announced", async () => {
    const info = { id: "ses_old", title: "old", directory: "/repo", time: { created: 1, updated: 2 } };
    const oc = fakeOpencode({
      "/session": () => Response.json([info]),
      "/session/ses_old": () => Response.json(info),
      "/session/ses_old/message": () => Response.json([]),
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const connected = (await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl }),
    }).then((r) => r.json())) as { id: string };
    // The connect's own sync imports the session once.
    expect((await fetch(`${base}/sync`, { method: "POST" })).status).toBe(200);

    const res = await fetch(`${base}/stream`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let reading = true;
    const pump = (async () => {
      while (reading) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    })();
    await Bun.sleep(100);
    const synced = (await fetch(`${base}/sync`, { method: "POST" }).then((r) => r.json())) as { imported: number };
    await Bun.sleep(100);
    reading = false;
    await reader.cancel();
    await pump.catch(() => {});

    expect(synced.imported).toBe(0);
    expect(text).toContain("service.connected");
    expect(text).not.toContain("sync.started");
    expect(text).not.toContain("sync.progress");
    expect(text).not.toContain("sync.finished");
    const conn = ((await fetch(`${base}/connections`).then((r) => r.json())) as {
      connections: { id: string; sync?: string }[];
    }).connections.find((c) => c.id === connected.id);
    expect(conn?.sync).toBe("idle");
    oc.stop();
    svc.stop();
  });
});
