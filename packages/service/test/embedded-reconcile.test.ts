import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { openStore } from "@agent-strata/store";
import { startService, type RunningService } from "../src/index";
import { sessionOrigin } from "../src/connections";
import { fakeOpencode } from "./fake-opencode";

/**
 * The status file is the shell's hand-off: a service that was not given the
 * embedded address at launch — restarted on its own, or watching a mode that
 * was switched to embed while the app was already open — still finds the
 * server and connects it.
 */

const tempDir = () => mkdtempSync(join(tmpdir(), "strata-embed-"));

function writeStatus(
  dir: string,
  state: string,
  url?: string,
  password?: string,
  generation?: string,
) {
  writeFileSync(
    join(dir, "opencode-status.json"),
    JSON.stringify({
      mode: "embed",
      state,
      ...(url ? { url } : {}),
      ...(password ? { username: "opencode", password } : {}),
      ...(generation ? { generation } : {}),
    }),
  );
}

function seedRunning(dir: string, sessionId: string, origin?: string) {
  const store = openStore(join(dir, "events.db"));
  store.append(
    [
      makeEvent({
        id: `${sessionId}:started`,
        session_id: sessionId,
        source: { backend: "opencode", native_id: sessionId.replace(/^opencode:/, "") },
        type: "session.started",
        data: { workspace: "/repo" },
        ts: "2026-01-01T00:00:00.000Z",
      } as EventInput),
      makeEvent({
        id: `${sessionId}:busy`,
        session_id: sessionId,
        source: { backend: "opencode", native_id: sessionId.replace(/^opencode:/, "") },
        type: "session.status",
        data: { state: "busy" },
        ts: "2026-01-01T00:00:01.000Z",
      } as EventInput),
    ],
    { origin, claimOrigin: true },
  );
  store.close();
}

async function sessionBusy(svc: RunningService) {
  const res = await fetch(`http://127.0.0.1:${svc.port}/sessions`);
  const body = (await res.json()) as { sessions: { summary: { session_id: string }; busy: boolean }[] };
  return Object.fromEntries(body.sessions.map((row) => [row.summary.session_id, row.busy]));
}

async function connections(svc: RunningService) {
  const res = await fetch(`http://127.0.0.1:${svc.port}/connections`);
  return (await res.json()) as {
    connections: { id: string; baseUrl: string; placement?: string }[];
  };
}

async function untilConnected(svc: RunningService, want: string, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs;
  let list = await connections(svc);
  while (Date.now() < deadline) {
    if (list.connections.some((c) => c.baseUrl === want)) return list;
    await Bun.sleep(100);
    list = await connections(svc);
  }
  return list;
}

describe("embedded reconcile", () => {
  let svc: RunningService | undefined;
  let fake: ReturnType<typeof fakeOpencode> | undefined;
  let dir = "";

  afterEach(() => {
    svc?.stop();
    svc = undefined;
    fake?.stop();
    fake = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  test("a new generation closes its old runs without a backend and leaves external work alone", async () => {
    dir = tempDir();
    seedRunning(dir, "opencode:old", sessionOrigin({ placement: "embed" }, "old"));
    seedRunning(dir, "opencode:legacy");
    seedRunning(dir, "opencode:current", sessionOrigin({ placement: "embed" }, "new"));
    seedRunning(dir, "opencode:external", sessionOrigin({ baseUrl: "http://external", placement: "external" }));
    writeStatus(dir, "stopped", undefined, undefined, "new");
    svc = startService({ db: join(dir, "events.db"), port: 0, desktopDir: dir });
    expect(await sessionBusy(svc)).toEqual({
      "opencode:old": false,
      "opencode:legacy": false,
      "opencode:current": true,
      "opencode:external": true,
    });
  });

  test("a remembered address that no longer answers does not keep the old marks standing", async () => {
    dir = tempDir();
    // A remembered external server that is gone. It cannot own a run, so it
    // must not count as an owner that stops the old marks from closing —
    // that is what left them standing forever on an upgraded store.
    writeFileSync(
      join(dir, "connections.json"),
      JSON.stringify([{ baseUrl: "http://gone", placement: "external" }]),
    );
    seedRunning(dir, "opencode:legacy");
    writeStatus(dir, "stopped", undefined, undefined, "new");
    svc = startService({ db: join(dir, "events.db"), port: 0, desktopDir: dir });
    expect((await sessionBusy(svc))["opencode:legacy"]).toBe(false);
  });

  test("the generation this process was given wins over a status file still holding the last one", async () => {
    dir = tempDir();
    fake = fakeOpencode();
    // The supervisor thread writes the status file a moment after the service
    // is spawned, so the file can still hold the previous run's generation
    // while this process was handed the new one. Believing the file would
    // hang the new connection on the old generation — and the recovery that
    // follows would then close the runs this connection is driving.
    writeStatus(dir, "running", fake.baseUrl, "pair-one", "old");
    seedRunning(dir, "opencode:previous", sessionOrigin({ placement: "embed" }, "old"));
    seedRunning(dir, "opencode:thisrun", sessionOrigin({ placement: "embed" }, "new"));
    svc = startService({
      db: join(dir, "events.db"),
      port: 0,
      desktopDir: dir,
      autoConnect: fake.baseUrl,
      autoConnectUsername: "opencode",
      autoConnectPassword: "pair-one",
      autoConnectGeneration: "new",
    });
    expect(await sessionBusy(svc)).toEqual({
      "opencode:previous": false,
      "opencode:thisrun": true,
    });
  });

  test("a generation change while the service is up also closes the old run", async () => {
    dir = tempDir();
    writeStatus(dir, "stopped", undefined, undefined, "old");
    svc = startService({
      db: join(dir, "events.db"),
      port: 0,
      desktopDir: dir,
      autoConnectGeneration: "old",
    });
    seedRunning(dir, "opencode:old", sessionOrigin({ placement: "embed" }, "old"));
    expect((await sessionBusy(svc))["opencode:old"]).toBe(true);
    writeStatus(dir, "stopped", undefined, undefined, "new");
    const deadline = Date.now() + 6_000;
    let busy = true;
    while (busy && Date.now() < deadline) {
      await Bun.sleep(100);
      busy = (await sessionBusy(svc))["opencode:old"] ?? false;
    }
    expect(busy).toBe(false);
  });

  test("a running status file a launch never announced still gets connected", async () => {
    dir = tempDir();
    fake = fakeOpencode();
    writeStatus(dir, "running", fake.baseUrl, "pair-one");
    svc = startService({ db: ":memory:", port: 0, desktopDir: dir });
    const list = await untilConnected(svc, fake.baseUrl);
    expect(list.connections).toHaveLength(1);
    expect(list.connections[0]!.placement).toBe("embed");
  });

  test("a parked login prompt connects nothing until the server runs", async () => {
    dir = tempDir();
    fake = fakeOpencode();
    writeStatus(dir, "authRequired", fake.baseUrl, "pair-one");
    svc = startService({ db: ":memory:", port: 0, desktopDir: dir });
    await Bun.sleep(400);
    expect((await connections(svc)).connections).toHaveLength(0);
    // The sign-in passing flips the same file to running — same pair — and
    // the reconcile picks it up on the next watch tick. Under a loaded suite
    // the fs.watch event can be late enough that only the 10s poll catches it,
    // so the timeout has to leave room for that fallback.
    writeStatus(dir, "running", fake.baseUrl, "pair-one");
    const list = await untilConnected(svc, fake.baseUrl, 12_000);
    expect(list.connections).toHaveLength(1);
    expect(list.connections[0]!.placement).toBe("embed");
  }, 15_000);

  test("a stopped server carries no pair and connects nothing", async () => {
    dir = tempDir();
    writeStatus(dir, "stopped");
    svc = startService({ db: ":memory:", port: 0, desktopDir: dir });
    await Bun.sleep(300);
    const list = await connections(svc);
    expect(list.connections).toHaveLength(0);
  });

  test("a respawned server with a rotated pair replaces the stale connection", async () => {
    dir = tempDir();
    fake = fakeOpencode();
    writeStatus(dir, "running", fake.baseUrl, "pair-one");
    svc = startService({ db: ":memory:", port: 0, desktopDir: dir });
    await untilConnected(svc, fake.baseUrl);

    // The supervisor keeps the port but rotates the password on every spawn.
    writeStatus(dir, "running", fake.baseUrl, "pair-two");
    const deadline = Date.now() + 6_000;
    let ok = false;
    while (Date.now() < deadline) {
      const list = await connections(svc);
      // One row, still the same address, but connected under the new pair.
      const row = list.connections.find((c) => c.baseUrl === fake!.baseUrl);
      if (list.connections.length === 1 && row) {
        ok = true;
        break;
      }
      await Bun.sleep(150);
    }
    expect(ok).toBe(true);
  });

  test("stopping closes the watcher and prevents a later status change from connecting", async () => {
    dir = tempDir();
    fake = fakeOpencode();
    writeStatus(dir, "authRequired", fake.baseUrl, "pair-one");
    svc = startService({ db: ":memory:", port: 0, desktopDir: dir });
    svc.stop();
    svc.stop();

    writeStatus(dir, "running", fake.baseUrl, "pair-one");
    await Bun.sleep(500);
    expect(fake.seen).toHaveLength(0);
  });

  test("a server the reader cut stays cut while the same pair stands", async () => {
    // This one waits for a connection, watches the file, waits for another
    // connection: up to twelve and a half seconds of it, and the suite's
    // default budget is five. Under a loaded suite the watcher event is late
    // enough that only the ten-second poll catches it, so the budget has to
    // leave room for that fallback — the same reason the parked login above
    // carries its own.
    dir = tempDir();
    fake = fakeOpencode();
    writeStatus(dir, "running", fake.baseUrl, "pair-one");
    svc = startService({ db: ":memory:", port: 0, desktopDir: dir });
    const connected = await untilConnected(svc, fake.baseUrl);
    const id = connected.connections[0]!.id;

    await fetch(`http://127.0.0.1:${svc.port}/connections/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    // Touch the status file so the watcher would reconcile right now.
    writeStatus(dir, "running", fake.baseUrl, "pair-one");
    await Bun.sleep(600);
    const list = await connections(svc);
    expect(list.connections).toHaveLength(0);

    // A respawn is a different server: the dismissal bound the pair it cut.
    writeStatus(dir, "running", fake.baseUrl, "pair-two");
    // The watcher is the fast way to hear about the new pair, and on a busy
    // machine its event can take seconds to arrive — the ten-second poll is
    // the fallback, so the wait has to be long enough to reach it.
    const revived = await untilConnected(svc, fake.baseUrl, 12_000);
    expect(revived.connections).toHaveLength(1);
  }, 25_000);
});
