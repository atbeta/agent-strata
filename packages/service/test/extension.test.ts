import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import type { BackendDriver } from "../src/driver";
import { extensionRoute } from "../src/extension-route";
import { fromAnotherSite, isLoopbackHost, shellCors } from "../src/shell-origin";
import { startService } from "../src/index";
import { fakeOpencode } from "./fake-opencode";

describe("the opencode extension through strata", () => {
  const upstream = fakeOpencode({
    "/command": () => Response.json([{ name: "init", template: "x", hints: [] }]),
    "/find/file": (url) =>
      url.searchParams.get("query")
        ? Response.json([`${url.searchParams.get("directory")}/a.ts`])
        : Response.json({ error: "query required" }, { status: 400 }),
    "/vcs": (url) => Response.json({ branch: "main", directory: url.searchParams.get("directory") }),
    "/session/ses_x/diff": (url) =>
      Response.json([{ file: "a.ts", patch: "@@ -1 +1 @@\n-a\n+b\n", additions: 1, deletions: 1, messageID: url.searchParams.get("messageID") }]),
    "/config": () => Response.json({ secret: true }),
  });
  let svc: ReturnType<typeof startService>;
  let base = "";
  let connId = "";
  beforeAll(async () => {
    svc = startService({ db: ":memory:", port: 0 });
    base = `http://127.0.0.1:${svc.port}`;
    const res = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: upstream.baseUrl, directory: "/conn" }),
    });
    connId = ((await res.json()) as { id: string }).id;
  });
  afterAll(() => {
    svc.stop();
    upstream.stop();
  });
  const conn = (p: string) => `${base}/connections/${encodeURIComponent(connId)}/opencode${p}`;
  const hits = (path: string) => upstream.seen.filter((s) => s.path === path).length;

  test("the connection lists the extension it carries", async () => {
    const { connections } = (await fetch(`${base}/connections`).then((r) => r.json())) as {
      connections: { capabilities: { extension?: string } }[];
    };
    expect(connections[0]!.capabilities.extension).toBe("opencode");
  });

  test("a connection read passes through in the connection's directory, not the caller's", async () => {
    const res = await fetch(conn("/command"));
    expect(await res.json()).toEqual([{ name: "init", template: "x", hints: [] }]);
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(((await fetch(conn("/vcs?directory=%2Frepo%2Fb")).then((r) => r.json())) as { directory: string }).directory).toBe(
      "/conn",
    );
  });

  test("the server's own error comes back with its status", async () => {
    expect((await fetch(conn("/find/file"))).status).toBe(400);
  });

  test("a session read uses the session's workspace, not the caller's", async () => {
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_x",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "x", workspace: "/repo/x" },
      } as EventInput),
    ]);
    const res = await fetch(
      `${base}/sessions/${encodeURIComponent("opencode:ses_x")}/opencode/find/file?query=a&directory=%2Fother`,
    );
    expect(await res.json()).toEqual(["/repo/x/a.ts"]);
  });

  test("a session diff is read for that session, never one named by the caller", async () => {
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_x",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "x", workspace: "/repo/x" },
      } as EventInput),
    ]);
    const res = await fetch(
      `${base}/sessions/${encodeURIComponent("opencode:ses_x")}/opencode/session/diff?messageID=m1&session=evil`,
    );
    const body = (await res.json()) as { file: string; messageID: string | null }[];
    expect(body[0]).toMatchObject({ file: "a.ts", messageID: "m1" });
    const hit = upstream.seen.filter((s) => s.path === "/session/ses_x/diff").at(-1);
    expect(hit?.query.get("directory")).toBe("/repo/x");
    expect(hit?.query.get("session")).toBeNull();
    expect((await fetch(`${base}/connections/${encodeURIComponent(connId)}/opencode/session/diff?session=evil`)).status).toBe(404);
    expect(upstream.seen.some((s) => s.path.includes("evil"))).toBe(false);
  });

  test("anything off the list, any other method, another backend's session, or an unknown connection goes nowhere", async () => {
    const commands = hits("/command");
    expect((await fetch(conn("/config"))).status).toBe(404);
    expect((await fetch(conn("/command"), { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}/sessions/${encodeURIComponent("acp:mock:1")}/opencode/command`)).status).toBe(404);
    expect(
      (await fetch(`${base}/connections/${encodeURIComponent("opencode:http://nowhere")}/opencode/command`)).status,
    ).toBe(404);
    expect(hits("/config")).toBe(0);
    expect(hits("/command")).toBe(commands);
  });

  test("only the desktop shell may read a response from another origin", async () => {
    const from = (origin: string) => fetch(conn("/command"), { headers: { origin } });
    expect((await from("http://tauri.localhost")).headers.get("access-control-allow-origin")).toBe(
      "http://tauri.localhost",
    );
    expect((await from("https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
    expect(shellCors("tauri://localhost")).toEqual({ "access-control-allow-origin": "tauri://localhost", vary: "origin" });
    expect(shellCors("http://localhost:5178")["access-control-allow-origin"]).toBe("http://localhost:5178");
    expect(shellCors(null)).toEqual({});
  });

  test("a session strata has no workspace for, or never heard of, goes nowhere", async () => {
    const vcs = hits("/vcs");
    svc.store.append([
      makeEvent({
        session_id: "opencode:ses_nowhere",
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "x", workspace: "unknown" },
      } as EventInput),
    ]);
    expect((await fetch(`${base}/sessions/${encodeURIComponent("opencode:ses_nowhere")}/opencode/vcs`)).status).toBe(404);
    expect((await fetch(`${base}/sessions/${encodeURIComponent("opencode:ses_ghost")}/opencode/vcs`)).status).toBe(404);
    expect((await fetch(`${base}/sessions/%E0%A4%A/opencode/vcs`)).status).toBe(404);
    expect(hits("/vcs")).toBe(vcs);
  });

  test("a request another site made the browser send never reaches the backend", async () => {
    const commands = hits("/command");
    const res = await fetch(conn("/command"), { headers: { "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(403);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await fetch(conn("/command"), { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(conn("/command"), { headers: { origin: "null" } })).status).toBe(403);
    expect(hits("/command")).toBe(commands);
    expect(fromAnotherSite("http://tauri.localhost", "cross-site")).toBe(false);
    expect(fromAnotherSite(null, "same-origin")).toBe(false);
    expect(fromAnotherSite(null, "none")).toBe(false);
    expect(fromAnotherSite(null, null)).toBe(false);
  });

  test("a backend that fails to answer is a bad gateway", async () => {
    const driver = {
      nativeId: () => "x",
      extension: {
        kind: "opencode" as const,
        paths: new Set(["/vcs"]),
        get: () => Promise.reject(new TypeError("connection refused")),
      },
    } as unknown as BackendDriver;
    const res = await extensionRoute(
      new Request("http://127.0.0.1:7700/connections/c/opencode/vcs", { headers: { host: "127.0.0.1:7700" } }),
      new URL("http://127.0.0.1:7700/connections/c/opencode/vcs"),
      { connection: () => driver, session: () => undefined },
    );
    expect(res!.status).toBe(502);
  });

  test("a request that names any host but this machine's loopback is refused", async () => {
    let reads = 0;
    const driver = {
      extension: {
        kind: "opencode" as const,
        paths: new Set(["/vcs"]),
        get: () => (reads++, Promise.resolve(Response.json({}))),
      },
    } as unknown as BackendDriver;
    const res = await extensionRoute(
      new Request("http://evil.example:7700/connections/c/opencode/vcs", { headers: { host: "evil.example:7700" } }),
      new URL("http://evil.example:7700/connections/c/opencode/vcs"),
      { connection: () => driver, session: () => undefined },
    );
    expect(res!.status).toBe(403);
    expect(reads).toBe(0);
    expect(isLoopbackHost("127.0.0.1:7700")).toBe(true);
    expect(isLoopbackHost("localhost:5178")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("evil.example")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.example")).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
  });
});
