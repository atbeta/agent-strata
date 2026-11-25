import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { startService, type RunningService } from "../src/index";
import { fakeOpencode } from "./fake-opencode";

let svc: RunningService | undefined;
let upstream: ReturnType<typeof fakeOpencode> | undefined;
let root = "";

afterEach(() => {
  svc?.stop();
  upstream?.stop();
  svc = undefined;
  upstream = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

async function setup(local = true) {
  root = mkdtempSync(join(tmpdir(), "strata-skill-routes-"));
  const workspace = join(root, "repo");
  const config = join(root, "config");
  const state = join(root, "state");
  let active: { name: string; location: string; content: string; description?: string }[] = [];
  upstream = fakeOpencode(
    {
      "/skill": () => Response.json(active),
      "/command": () => Response.json([]),
      "/project": () => Response.json([{ id: "project", name: "repo", worktree: workspace, sandboxes: [] }]),
    },
    undefined,
    "0.0.0.0",
  );
  writeFileSync(join(root, "status.json"), "{}");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(state, "opencode-status.json"),
    JSON.stringify(local ? { state: "running", url: upstream.baseUrl } : { state: "external" }),
  );
  writeFileSync(join(state, "desktop.json"), JSON.stringify({ opencode: local ? "embed" : "external" }));
  svc = startService({
    db: ":memory:",
    port: 0,
    desktopDir: state,
    opencodeConfigDir: config,
    autoConnectTimeoutMs: -1,
  });
  const base = `http://127.0.0.1:${svc.port}`;
  const connected = await fetch(`${base}/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: upstream.baseUrl, directory: workspace }),
  });
  expect(connected.status).toBe(200);
  const connection = ((await connected.json()) as { id: string }).id;
  const query = `connection=${encodeURIComponent(connection)}&workspace=${encodeURIComponent(workspace)}`;
  return {
    base,
    workspace,
    config,
    connection,
    query,
    setActive(value: typeof active) {
      active = value;
    },
  };
}

describe("skill management routes", () => {
  test("an embedded connection lists, creates, edits and deletes only managed local skills", async () => {
    const app = await setup();
    const read = () => fetch(`${app.base}/skills?${app.query}`).then((res) => res.json());
    expect((await read()).skills).toEqual([]);
    const created = await fetch(`${app.base}/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connection: app.connection,
        workspace: app.workspace,
        scope: "project",
        id: "release",
        name: "Release",
        description: "Prepare a release",
        content: "Read the policy.\n",
        autoInvoke: false,
        path: "/tmp/ignored",
      }),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ ok: true, reloaded: true });
    const file = join(app.workspace, ".opencode", "skills", "release", "SKILL.md");
    expect(readFileSync(file, "utf8")).toContain("opencode/autoinvoke: false");
    const listed = await read();
    const skill = listed.skills[0];
    expect(skill).toMatchObject({
      id: "release",
      name: "Release",
      status: "inactive",
      writable: true,
      source: "opencode-project",
    });
    app.setActive([{ name: "Release", location: file, content: "Read the policy.\n" }]);
    expect((await read()).skills[0].status).toBe("active");
    const patched = await fetch(`${app.base}/skills/${skill.key}?${app.query}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Careful Release", content: "Ask first.\n", autoInvoke: true }),
    });
    expect(patched.status).toBe(200);
    expect(readFileSync(file, "utf8")).toContain("name: Careful Release");
    expect(readFileSync(file, "utf8")).toContain("description: Prepare a release");
    expect(readFileSync(file, "utf8")).toContain("Ask first.");
    const removed = await fetch(`${app.base}/skills/${skill.key}?${app.query}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
    app.setActive([]);
    expect((await read()).skills).toEqual([]);
    const invalid = await fetch(`${app.base}/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connection: app.connection,
        workspace: app.workspace,
        scope: "project",
        id: "../outside",
      }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).code).toBe("skill_id");
    const globalCreate = await fetch(`${app.base}/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connection: app.connection,
        workspace: app.workspace,
        scope: "global",
        id: "global-note",
        content: "Global body",
      }),
    });
    expect(globalCreate.status).toBe(200);
    expect(readFileSync(join(app.config, "skills", "global-note", "SKILL.md"), "utf8")).toContain("Global body");
    expect(upstream!.seen.some((entry) => entry.path === "/command")).toBe(true);
  });

  test("a loopback server is writable even in external mode, and an unknown workspace never reaches OpenCode", async () => {
    // The files are on this machine whoever spawned the server — external
    // mode is a lifecycle choice, not a place. Before the tier read machine
    // locality, this connection was wrongly read-only.
    const app = await setup(false);
    const res = await fetch(`${app.base}/skills?${app.query}`);
    const body = await res.json();
    expect(body.connection.local).toBe(true);
    const before = upstream!.seen.filter((entry) => entry.path === "/skill").length;
    const unknown = await fetch(
      `${app.base}/skills?connection=${encodeURIComponent(app.connection)}&workspace=${encodeURIComponent(join(root, "other"))}`,
    );
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).code).toBe("workspace_unknown");
    expect(upstream!.seen.filter((entry) => entry.path === "/skill").length).toBe(before);
  });

  test("a server reached through a non-loopback address is read-only", async () => {
    const app = await setup(false);
    // The same server, addressed by the machine's LAN identity: loopback is
    // this machine, anything else is not — the tier the reader sees follows
    // the address, so the read-only path is exercised end to end. Skipped
    // where the machine has no non-loopback address at all.
    const lan = lanAddress();
    if (!lan) return;
    const remoteBase = `${app.base}/connect`;
    const connected = await fetch(remoteBase, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: `http://${lan}:${upstream!.port}`, directory: app.workspace }),
    });
    if (connected.status !== 200) return;
    const connection = ((await connected.json()) as { id: string }).id;
    const query = `connection=${encodeURIComponent(connection)}&workspace=${encodeURIComponent(app.workspace)}`;
    const location = join(app.workspace, ".opencode", "skills", "remote", "SKILL.md");
    app.setActive([{ name: "Remote", location, content: "Remote body" }]);
    const res = await fetch(`${app.base}/skills?${query}`);
    const body = await res.json();
    expect(body.connection.local).toBe(false);
    expect(body.skills[0]).toMatchObject({ writable: false, readonlyReason: "remote", status: "active" });
    const created = await fetch(`${app.base}/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ connection, workspace: app.workspace, scope: "project", id: "no-write" }),
    });
    expect(created.status).toBe(403);
  });
});

/** The machine's first non-loopback IPv4 address, if it has one. */
function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === "IPv4" && !item.internal) return item.address;
    }
  }
  return undefined;
}
