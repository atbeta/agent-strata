import { describe, expect, test } from "bun:test";
import { startService } from "../src/index";
import { fakeOpencode } from "./fake-opencode";
import { ev } from "./service-harness";

describe("session MCP routes", () => {
  test("an OpenCode session can connect and disconnect an MCP server", async () => {
    const oc = fakeOpencode({
      "/mcp/srv/connect": () => Response.json({ status: "connected" }),
      "/mcp/srv/disconnect": () => Response.json({ status: "connected" }),
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (p: string, body?: unknown) => fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await post("/connect", { baseUrl: oc.baseUrl, directory: "/repo" });
    svc.store.append([ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z")]);
    const sid = encodeURIComponent("opencode:ses_x");
    const name = encodeURIComponent("srv");
    const connect = await post(`/sessions/${sid}/mcp/${name}/connect`);
    expect(connect.status).toBe(200);
    expect(await connect.json()).toEqual({ ok: true });
    expect(oc.seen.some((s) => s.method === "POST" && s.path === "/mcp/srv/connect")).toBe(true);
    const disconnect = await post(`/sessions/${sid}/mcp/${name}/disconnect`);
    expect(disconnect.status).toBe(200);
    expect(await disconnect.json()).toEqual({ ok: true });
    expect(oc.seen.some((s) => s.method === "POST" && s.path === "/mcp/srv/disconnect")).toBe(true);
    oc.stop();
    svc.stop();
  });

  test("an OpenCode session can add an MCP server without receiving its config back", async () => {
    const oc = fakeOpencode({ "/mcp": () => Response.json({ leaked: "https://mcp.example/secret-token" }) });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (p: string, body?: unknown) => fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await post("/connect", { baseUrl: oc.baseUrl, directory: "/repo" });
    svc.store.append([ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z")]);
    const sid = encodeURIComponent("opencode:ses_x");
    const added = await post(`/sessions/${sid}/mcp`, { name: "docs", url: "https://mcp.example/rpc" });
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ ok: true });
    const seen = oc.seen.find((s) => s.method === "POST" && s.path === "/mcp");
    expect(JSON.parse(seen!.body)).toEqual({ name: "docs", config: { type: "remote", url: "https://mcp.example/rpc" } });
    expect(seen!.query.get("directory")).toBe("/repo");
    const refused = await post(`/sessions/${sid}/mcp`, {
      name: "docs",
      config: { type: "local", command: ["echo", "secret-token-value"] },
    });
    expect(refused.status).toBe(400);
    expect(oc.seen.filter((s) => s.method === "POST" && s.path === "/mcp")).toHaveLength(1);
    oc.stop();
    svc.stop();
  });

  test("an MCP add error that repeats the address is not returned", async () => {
    const url = "https://mcp.example/secret-token";
    const oc = fakeOpencode({ "/mcp": () => Response.json({ message: `refused ${url}` }, { status: 400 }) });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });
    svc.store.append([ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z")]);
    const added = await fetch(`${base}/sessions/${encodeURIComponent("opencode:ses_x")}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "docs", url }),
    });
    expect(added.status).toBe(502);
    const body = await added.text();
    expect(body).not.toContain("secret-token");
    expect(JSON.parse(body)).toEqual({ error: "mcp add failed" });
    oc.stop();
    svc.stop();
  });

  test("MCP OAuth returns a login URL and keeps the state and code out of the response", async () => {
    const state = "state-secret-value";
    const code = "paste-this-code-value";
    const oc = fakeOpencode({
      "/mcp/docs/auth": () => Response.json({ authorizationUrl: "https://idp.example/authorize", oauthState: state }),
      "/mcp/docs/auth/callback": () => Response.json({ message: `refused ${code}` }, { status: 400 }),
      "/mcp/bad/auth": () => Response.json({ authorizationUrl: "javascript:alert(1)", oauthState: state }),
      "/mcp/ready/auth": () => Response.json({ authorizationUrl: "", oauthState: state }),
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (p: string, body?: unknown) => fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await post("/connect", { baseUrl: oc.baseUrl, directory: "/repo" });
    svc.store.append([ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z")]);
    const sid = encodeURIComponent("opencode:ses_x");
    const started = await post(`/sessions/${sid}/mcp/docs/auth`);
    expect(started.status).toBe(200);
    const startedText = await started.text();
    expect(startedText).not.toContain(state);
    expect(JSON.parse(startedText)).toEqual({ url: "https://idp.example/authorize" });
    expect(oc.seen.find((s) => s.path === "/mcp/docs/auth")?.query.get("directory")).toBe("/repo");
    expect((await post(`/sessions/${sid}/mcp/docs/auth/callback`, {})).status).toBe(400);
    const finished = await post(`/sessions/${sid}/mcp/docs/auth/callback`, { code });
    expect(finished.status).toBe(502);
    const finishedText = await finished.text();
    expect(finishedText).not.toContain(code);
    expect(JSON.parse(finishedText)).toEqual({ error: "mcp auth failed" });
    expect(JSON.parse(oc.seen.find((s) => s.path === "/mcp/docs/auth/callback")!.body)).toEqual({ code });
    const script = await post(`/sessions/${sid}/mcp/bad/auth`);
    expect(script.status).toBe(502);
    expect(await script.text()).not.toContain("javascript");
    const ready = await post(`/sessions/${sid}/mcp/ready/auth`);
    expect(await ready.json()).toEqual({ ok: true });
    oc.stop();
    svc.stop();
  });
});
