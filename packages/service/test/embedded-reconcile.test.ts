import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startService, type RunningService } from "../src/index";
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
) {
  writeFileSync(
    join(dir, "opencode-status.json"),
    JSON.stringify({
      mode: "embed",
      state,
      ...(url ? { url } : {}),
      ...(password ? { username: "opencode", password } : {}),
    }),
  );
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

  test("a running status file a launch never announced still gets connected", async () => {
    dir = tempDir();
    fake = fakeOpencode();
    writeStatus(dir, "running", fake.baseUrl, "pair-one");
    svc = startService({ db: ":memory:", port: 0, desktopDir: dir });
    const list = await untilConnected(svc, fake.baseUrl);
    expect(list.connections).toHaveLength(1);
    expect(list.connections[0]!.placement).toBe("embed");
  });

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

  test("a server the reader cut stays cut while the same pair stands", async () => {
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
    const revived = await untilConnected(svc, fake.baseUrl, 6_000);
    expect(revived.connections).toHaveLength(1);
  });
});
