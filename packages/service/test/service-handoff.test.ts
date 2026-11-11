import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startService } from "../src/index";
import { fakeOpencode } from "./fake-opencode";
import { ev } from "./service-harness";

describe("handoff", () => {
  test("a handoff opens a new session on another backend and leaves the source", async () => {
    const MOCK = fileURLToPath(new URL("../../adapter-acp/test/fixtures/mock-agent.ts", import.meta.url));
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (p: string, body?: unknown) => fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sid = "opencode:handed";
    svc.store.append([
      ev(sid, "session.started", { title: "auth", workspace: "/repo" }, "2026-01-01T00:00:00Z"),
      ev(sid, "session.goal", { text: "ship the auth fix" }, "2026-01-01T00:00:01Z"),
      ev(sid, "turn.user", { turn_id: "t1", content: [{ type: "text", text: "fix login" }] }, "2026-01-01T00:00:02Z"),
      ev(sid, "tool.call", { turn_id: "t1", call_id: "c1", tool: "bash", input: { command: "INPUT_SENTINEL" } }, "2026-01-01T00:00:03Z"),
      ev(sid, "tool.result", { call_id: "c1", status: "ok", output: `OUTPUT_SENTINEL ${"x".repeat(30_000)}` }, "2026-01-01T00:00:04Z"),
      ev(sid, "file.changed", { path: "src/auth.ts", change: "modify", diff: `DIFF_SENTINEL ${"y".repeat(30_000)}`, call_id: "c1" }, "2026-01-01T00:00:05Z"),
    ]);
    const before = svc.store.read({ session_id: sid }).length;
    const connected = await post("/connect", {
      backend: "acp", command: process.execPath, args: [MOCK], agentName: "mock", cwd: tmpdir(),
    }).then((r) => r.json());
    expect((await post(`/sessions/${encodeURIComponent(sid)}/handoff`, {})).status).toBe(400);
    expect((await post(`/sessions/${encodeURIComponent("missing:1")}/handoff`, { connection_id: connected.id })).status).toBe(404);
    const handed = await post(`/sessions/${encodeURIComponent(sid)}/handoff`, { connection_id: connected.id });
    expect(handed.status).toBe(200);
    const created = (await handed.json()) as { id: string };
    expect(created.id).toStartWith("acp:mock:");
    expect(created.id).not.toBe(sid);
    expect(svc.store.read({ session_id: sid })).toHaveLength(before);
    expect(JSON.stringify(svc.store.read({ session_id: sid }))).toContain("OUTPUT_SENTINEL");
    const started = Date.now();
    let prompt = "";
    while (Date.now() - started < 3_000) {
      const view = await fetch(`${base}/sessions/${encodeURIComponent(created.id)}/view`).then((r) => r.json());
      const text = view.turns?.[0]?.user?.[0]?.text ?? "";
      if (text) {
        prompt = text;
        expect(view.workspace).toBe("/repo");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(prompt).toContain("ship the auth fix");
    expect(prompt).toContain("src/auth.ts");
    expect(prompt).toContain("fix login");
    expect(prompt).not.toContain("OUTPUT_SENTINEL");
    expect(prompt).not.toContain("INPUT_SENTINEL");
    expect(prompt).not.toContain("DIFF_SENTINEL");
    const owned = await post("/sessions", { connection_id: connected.id, directory: tmpdir() }).then((r) => r.json());
    const same = await post(`/sessions/${encodeURIComponent(owned.id)}/handoff`, { connection_id: connected.id });
    expect(same.status).toBe(200);
    const continued = (await same.json()) as { id: string };
    expect(continued.id).not.toBe(owned.id);
    expect(continued.id).toStartWith("acp:mock:");
    expect(await fetch(`${base}/sessions/${encodeURIComponent(owned.id)}/view`).then((r) => r.status)).toBe(200);
    svc.stop();
  });

  test("the first prompt uses the composer's model, agent and effort", async () => {
    const upstream = fakeOpencode({
      "/session": (_url, req) => req.method === "POST" ? Response.json({ id: "ses_handoff" }) : Response.json([]),
      "/session/ses_handoff/prompt_async": () => new Response(null, { status: 204 }),
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    try {
      const connected = await post("/connect", { baseUrl: upstream.baseUrl, directory: "/conn" }).then((r) => r.json());
      svc.store.append([ev("opencode:source", "session.started", { title: "source", workspace: "/repo" }, "2026-01-01T00:00:00Z")]);
      const res = await post("/sessions/opencode%3Asource/handoff", {
        connection_id: connected.id,
        model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" },
        agent: "build",
        variant: "high",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: "opencode:ses_handoff" });
      const sent = upstream.seen.find((s) => s.path === "/session/ses_handoff/prompt_async");
      expect(sent?.query.get("directory")).toBe("/repo");
      expect(JSON.parse(sent!.body)).toMatchObject({
        model: { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" },
        agent: "build",
        variant: "high",
      });
    } finally {
      svc.stop();
      upstream.stop();
    }
  });
});
