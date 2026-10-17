import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { startService } from "../src/index";
import { fakeOpencode } from "./fake-opencode";

const SESSION = "opencode:ses_term";

describe("a session terminal", () => {
  const tickets: { header: string | null; authorization: string | null }[] = [];
  const upstream = fakeOpencode(
    {
      "/pty/shells": () =>
        Response.json([
          { name: "pwsh", path: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", acceptable: true },
          { name: "nope", path: "C:/evil.exe", acceptable: false },
        ]),
      "/pty": (url, req) => {
        if (req.method === "GET")
          return Response.json([
            { id: "pty_1", title: "shell", command: "pwsh", cwd: url.searchParams.get("directory"), status: "running", pid: 1 },
          ]);
        if (req.method === "POST")
          return Response.json({
            id: "pty_1",
            title: "shell",
            command: "pwsh",
            cwd: url.searchParams.get("directory"),
            status: "running",
            pid: 1,
          });
        return new Response(null, { status: 405 });
      },
      "/pty/pty_1": () =>
        Response.json({ id: "pty_1", title: "shell", command: "pwsh", cwd: "/repo/x", status: "running", pid: 1 }),
      "/pty/pty_1/connect-token": (_url, req) => {
        tickets.push({
          header: req.headers.get("x-opencode-ticket"),
          authorization: req.headers.get("authorization"),
        });
        return Response.json({ ticket: "ticket-secret", expires_in: 30 });
      },
    },
    {
      message(ws, message) {
        ws.send(`echo:${String(message)}`);
      },
    },
  );
  let svc: ReturnType<typeof startService>;
  let base = "";

  beforeAll(async () => {
    svc = startService({ db: ":memory:", port: 0 });
    base = `http://127.0.0.1:${svc.port}`;
    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: upstream.baseUrl, password: "s3cret" }),
    });
    svc.store.append([
      makeEvent({
        session_id: SESSION,
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "x", workspace: "/repo/x" },
      } as EventInput),
    ]);
  });
  afterAll(() => {
    svc.stop();
    upstream.stop();
  });

  const posts = () => upstream.seen.filter((s) => s.method === "POST" && s.path === "/pty");

  test("the listing carries the shells the backend will run", async () => {
    const res = await fetch(`${base}/sessions/${encodeURIComponent(SESSION)}/terminal`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: { id: string }[];
      shells: { name: string; path: string; acceptable: boolean }[];
    };
    expect(body.sessions.map((s) => s.id)).toEqual(["pty_1"]);
    // Reported as it came, unacceptable entries included: the page has to be able
    // to say a shell is missing rather than act as if it was never asked for.
    expect(body.shells).toEqual([
      { name: "pwsh", path: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe", acceptable: true },
      { name: "nope", path: "C:/evil.exe", acceptable: false },
    ]);
  });

  test("a shell is created in the session workspace, and the password stays here", async () => {
    const res = await fetch(`${base}/sessions/${encodeURIComponent(SESSION)}/terminal`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5178" },
      body: JSON.stringify({ shell: "pwsh", cwd: "C:/evil", env: { TOKEN: "s3cret" }, title: "构建" }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("ticket-secret");
    const body = JSON.parse(posts().at(-1)!.body) as { cwd: string; command: string; env?: unknown; title: string };
    expect(body.cwd).toBe("/repo/x");
    expect(body.command).toBe("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
    expect(body.title).toBe("构建");
    expect(body.env).toBeUndefined();
    expect(posts().at(-1)!.query.get("directory")).toBe("/repo/x");
  });

  test("a shell the backend did not offer is refused", async () => {
    const before = posts().length;
    const res = await fetch(`${base}/sessions/${encodeURIComponent(SESSION)}/terminal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shell: "nope" }),
    });
    expect(res.status).toBe(400);
    expect(posts().length).toBe(before);
  });

  test("another site cannot open a shell", async () => {
    const res = await fetch(`${base}/sessions/${encodeURIComponent(SESSION)}/terminal`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  test("the page socket is bridged without the ticket", async () => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${svc.port}/sessions/${encodeURIComponent(SESSION)}/terminal/pty_1/connect`,
    );
    const echoed = new Promise<string>((resolve, reject) => {
      ws.onmessage = (ev) => resolve(String(ev.data));
      ws.onerror = () => reject(new Error("socket failed"));
    });
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("socket failed"));
    });
    ws.send("hi");
    expect(await echoed).toBe("echo:hi");
    ws.close();
    const connect = upstream.seen.find((s) => s.path === "/pty/pty_1/connect");
    expect(connect?.query.get("ticket")).toBe("ticket-secret");
    expect(connect?.query.get("directory")).toBe("/repo/x");
    expect(tickets.at(-1)?.header).toBe("1");
    expect(tickets.at(-1)?.authorization).toBe(`Basic ${btoa(":s3cret")}`);
    expect(ws.url).not.toContain("ticket");
  });

  test("a size outside the grid is refused", async () => {
    const bad = await fetch(`${base}/sessions/${encodeURIComponent(SESSION)}/terminal/pty_1/size`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows: 0, cols: 80 }),
    });
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/sessions/${encodeURIComponent(SESSION)}/terminal/pty_1/size`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rows: 24, cols: 80 }),
    });
    expect(ok.status).toBe(200);
    const put = [...upstream.seen].reverse().find((s) => s.method === "PUT" && s.path === "/pty/pty_1");
    expect(JSON.parse(put!.body)).toEqual({ size: { rows: 24, cols: 80 } });
  });

  test("a path is not a terminal id", async () => {
    const res = await fetch(`${base}/sessions/${encodeURIComponent(SESSION)}/terminal/${encodeURIComponent("../x")}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });
});

describe("a backend with no shell list", () => {
  const upstream = fakeOpencode({
    // An older opencode answers /pty/shells with nothing at all. The pane still
    // has to show the terminals that are already running.
    "/pty/shells": () => new Response("not found", { status: 404 }),
    "/pty": (url) =>
      Response.json([
        { id: "pty_9", title: "shell", command: "", cwd: url.searchParams.get("directory"), status: "running", pid: 9 },
      ]),
  });
  let svc: ReturnType<typeof startService>;
  let base = "";

  beforeAll(async () => {
    svc = startService({ db: ":memory:", port: 0 });
    base = `http://127.0.0.1:${svc.port}`;
    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: upstream.baseUrl, password: "s3cret" }),
    });
    svc.store.append([
      makeEvent({
        session_id: SESSION,
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "x", workspace: "/repo/x" },
      } as EventInput),
    ]);
  });
  afterAll(() => {
    svc.stop();
    upstream.stop();
  });

  test("still lists its terminals, and offers no shells to choose from", async () => {
    const res = await fetch(`${base}/sessions/${encodeURIComponent(SESSION)}/terminal`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: { id: string }[]; shells: unknown[] };
    expect(body.sessions.map((s) => s.id)).toEqual(["pty_9"]);
    expect(body.shells).toEqual([]);
  });
});
