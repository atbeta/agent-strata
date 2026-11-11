import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { startService } from "../src/index";
import { seed } from "./service-harness";

describe("backend and core service integration", () => {
  test("an ACP agent connects as a backend and runs a prompt", async () => {
    const MOCK = fileURLToPath(new URL("../../adapter-acp/test/fixtures/mock-agent.ts", import.meta.url));
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (p: string, body: unknown) =>
      fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const connected = await post("/connect", {
      backend: "acp", command: process.execPath, args: [MOCK], agentName: "mock", cwd: tmpdir(),
    }).then((r) => r.json());
    expect(connected.id).toStartWith("acp:mock:");
    const conns = await fetch(`${base}/connections`).then((r) => r.json());
    expect(conns.connections[0]).toMatchObject({ backend: "acp", capabilities: { prompt: true, models: false } });

    const created = await post("/sessions", { connection_id: connected.id, directory: tmpdir() }).then((r) => r.json());
    expect(created.id).toStartWith("acp:mock:");
    expect((await post(`/sessions/${encodeURIComponent(created.id)}/prompt`, { text: "diff" })).status).toBe(200);
    const withImage = await post(`/sessions/${encodeURIComponent(created.id)}/prompt`, {
      parts: [{ type: "text", text: "x" }, { type: "attachment", mime: "image/png", url: "data:image/png;base64,AA==" }],
    });
    expect(withImage.status).toBe(400);
    expect(((await withImage.json()) as { error: string }).error).toMatch(/files or attachments/);
    const command = await post(`/sessions/${encodeURIComponent(created.id)}/command`, { command: "init" });
    expect(command.status).toBe(400);
    expect(((await command.json()) as { error: string }).error).toMatch(/cannot run commands/);
    expect(await fetch(`${base}/sessions/${encodeURIComponent(created.id)}/capabilities`).then((r) => r.json())).toMatchObject({
      connected: true,
      commands: false,
      attachments: false,
    });
    const acpCaps = (await fetch(`${base}/sessions/${encodeURIComponent(created.id)}/capabilities`).then((r) => r.json())) as Record<string, unknown>;
    expect(acpCaps.revert).toBeUndefined();
    expect(acpCaps.fork).toBeUndefined();
    expect(acpCaps.summarize).toBeUndefined();
    expect((await post(`/sessions/${encodeURIComponent(created.id)}/revert`, { message_id: "m1" })).status).toBe(400);
    expect((await post(`/sessions/${encodeURIComponent(created.id)}/mcp/${encodeURIComponent("srv")}/disconnect`, {})).status).toBe(400);

    const view = () => fetch(`${base}/sessions/${encodeURIComponent(created.id)}/view`).then((r) => r.json());
    let v = await view();
    for (let i = 0; i < 60 && (v.busy || v.files_changed.length === 0); i++) {
      await Bun.sleep(50);
      v = await view();
    }
    expect(v.backend).toBe("acp");
    expect(v.busy).toBe(false);
    expect(v.files_changed.map((f: { path: string }) => f.path).sort()).toEqual(["new.ts", "old.ts"]);
    expect(v.files_changed.every((f: { unexplained: boolean }) => !f.unexplained)).toBe(true);
    await fetch(`${base}/connections/${encodeURIComponent(connected.id)}`, { method: "DELETE" });
    svc.stop();
  });

  test("one session driven over two channels is stored once, and released when its owner goes", async () => {
    const MOCK = fileURLToPath(new URL("../../adapter-acp/test/fixtures/mock-agent.ts", import.meta.url));
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (p: string, body: unknown) =>
      fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const connected = await post("/connect", {
      backend: "acp", command: process.execPath, args: [MOCK], agentName: "opencode", cwd: tmpdir(),
    }).then((r) => r.json());
    const created = await post("/sessions", { connection_id: connected.id, directory: tmpdir() }).then((r) => r.json());
    const native = created.native_id;
    const shadow = `opencode:${native}`;
    expect(created.id).toBe(`acp:opencode:${native}`);
    const sessionIds = async () =>
      (await fetch(`${base}/sessions`).then((r) => r.json())).sessions
        .map((s: { summary: { session_id: string } }) => s.summary.session_id)
        .sort();

    const httpSays = makeEvent({
      session_id: shadow,
      source: { backend: "opencode", native_id: native },
      type: "session.started",
      data: { workspace: "/tmp" },
    } as EventInput);
    svc.sink.append([httpSays]);
    svc.sink.append([
      makeEvent({
        session_id: shadow,
        source: { backend: "opencode", native_id: native },
        type: "turn.user",
        data: { turn_id: "t1", content: [{ type: "text", text: "from the other channel" }] },
      } as EventInput),
    ]);
    expect(await sessionIds()).toEqual([created.id]);
    expect(svc.store.read({ session_id: shadow })).toEqual([]);
    expect(svc.sink.replaceSession(shadow, [httpSays], { replaceTypes: ["session.started"] })).toBe(0);

    svc.sink.append([
      makeEvent({
        session_id: `acp:claude-code:${native}`,
        source: { backend: "acp", agent: "claude-code", native_id: native },
        type: "session.started",
        data: { workspace: "/tmp" },
      } as EventInput),
    ]);
    expect(await sessionIds()).toEqual([`acp:claude-code:${native}`, created.id].sort());
    await fetch(`${base}/connections/${encodeURIComponent(connected.id)}`, { method: "DELETE" });
    svc.sink.append([httpSays]);
    expect(await sessionIds()).toEqual([`acp:claude-code:${native}`, created.id, shadow].sort());
    svc.stop();
  });

  test("health, sessions, events, view, compare, export", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const healthRes = await fetch(`${base}/health`);
    expect(healthRes.headers.get("access-control-allow-origin")).toBeNull();
    const health = await healthRes.json();
    expect(health.ok).toBe(true);
    expect((await fetch(`${base}/connect`, { method: "OPTIONS" })).status).toBe(204);
    const sync = await fetch(`${base}/sync`, { method: "POST" }).then((r) => r.json());
    expect(sync).toEqual({ connected: false, imported: 0, reconciled: 0 });

    seed(svc);
    seed(svc, "opencode:s2");
    const sessions = await fetch(`${base}/sessions`).then((r) => r.json());
    expect(sessions.sessions.length).toBe(2);
    expect(sessions.aggregate.total.cost_usd).toBeCloseTo(0.002);
    const events = await fetch(`${base}/events?session_id=opencode:s1&types=turn.user`).then((r) => r.json());
    expect(events.events.length).toBe(1);
    expect(events.events[0].type).toBe("turn.user");
    const text = await fetch(`${base}/events?text=hello`).then((r) => r.json());
    expect(text.events.length).toBe(2);
    expect((await fetch(`${base}/events?after_seq=abc`)).status).toBe(400);
    const view = await fetch(`${base}/sessions/opencode:s1/view`).then((r) => r.json());
    expect(view.totals.input).toBe(10);
    expect(view.status).toBe("active");
    const at2 = await fetch(`${base}/sessions/opencode:s1/view?until_seq=2`).then((r) => r.json());
    expect(at2.turns[0].assistant.length).toBe(0);
    expect(at2.totals.input).toBe(0);
    const cmp = await fetch(`${base}/compare?a=opencode:s1&b=opencode:s2`).then((r) => r.json());
    expect(cmp.summary.same_prompt).toBeGreaterThanOrEqual(1);
    expect(cmp.turn_pairs.length).toBeGreaterThanOrEqual(1);
    const exported = await fetch(`${base}/export?session_id=opencode:s1`).then((r) => r.text());
    const lines = exported.trim().split("\n");
    expect(JSON.parse(lines[0]!).event_count).toBe(3);
    expect(lines.length).toBe(4);

    const bad = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "http://127.0.0.1:1", connectTimeoutMs: 50 }),
    });
    expect(bad.status).toBe(502);
    const pending = await fetch(`${base}/permissions`).then((r) => r.json());
    expect(pending.pending).toEqual([]);
    const respond404 = await fetch(`${base}/permissions/nope/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(respond404.status).toBe(404);
    const options = await fetch(`${base}/options`).then((r) => r.json());
    expect(options).toEqual({ models: [], agents: [] });
    expect((await fetch(`${base}/sessions/opencode:s1/abort`, { method: "POST" })).status).toBe(400);
    const questions = await fetch(`${base}/questions`).then((r) => r.json());
    expect(questions.pending).toEqual([]);
    const q404 = await fetch(`${base}/questions/nope/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject" }),
    });
    expect(q404.status).toBe(404);
    svc.stop();
  });
});
