import { describe, expect, test } from "bun:test";
import { startService } from "../src/index";
import { fakeOpencode } from "./fake-opencode";
import { ev, seed } from "./service-harness";

describe("session read and action routes", () => {
  test("archive and delete flags hide from the view, workspaces come from sessions", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    seed(svc, "opencode:live");
    svc.store.append([
      ev("opencode:live", "session.updated", { title: "renamed" }, "2026-01-01T00:00:03Z"),
      ev("opencode:boxed", "session.started", { title: "boxed", workspace: "/tmp/box" }, "2026-01-02T00:00:00Z"),
      ev("opencode:boxed", "session.updated", { archived: true }, "2026-01-02T00:00:01Z"),
      ev("opencode:gone", "session.started", { title: "gone", workspace: "/tmp/x" }, "2026-01-03T00:00:00Z"),
      ev("opencode:gone", "session.deleted", {}, "2026-01-03T00:00:01Z"),
    ]);
    const view = await fetch(`${base}/sessions/${encodeURIComponent("opencode:live")}/view`).then((r) => r.json());
    expect(view.title).toBe("renamed");
    const sessions = await fetch(`${base}/sessions`).then((r) => r.json());
    const byId = Object.fromEntries(sessions.sessions.map((s: { summary: { session_id: string } }) => [s.summary.session_id, s]));
    expect(byId["opencode:live"].archived).toBe(false);
    expect(byId["opencode:live"].title).toBe("renamed");
    expect(byId["opencode:boxed"].archived).toBe(true);
    expect(byId["opencode:gone"].deleted).toBe(true);
    const workspaces = await fetch(`${base}/workspaces`).then((r) => r.json());
    expect(workspaces.workspaces.map((w: { directory: string }) => w.directory).sort()).toEqual(["/tmp/box", "/tmp/x"]);
    const rename = await fetch(`${base}/sessions/${encodeURIComponent("opencode:live")}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "nope" }),
    });
    expect(rename.status).toBe(400);
    svc.stop();
  });

  test("session search finds text and gives every hit a way back to its turn", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const sid = "opencode:findme";
    svc.store.append([
      ev(sid, "session.started", { title: "findme", workspace: "/tmp/x" }, "2026-01-01T00:00:00Z"),
      ev(sid, "turn.assistant", {
        turn_id: "t1", content: [{ type: "text", text: "the anchor is a scrollTop reader" }], stop_reason: "end_turn",
      }, "2026-01-01T00:00:01Z"),
      ev(sid, "tool.call", { turn_id: "t2", call_id: "c1", tool: "bash", input: { command: "echo scrollTop" } }, "2026-01-01T00:00:02Z"),
      ev(sid, "tool.result", { call_id: "c1", status: "ok", output: "printed scrollTop to stdout" }, "2026-01-01T00:00:03Z"),
      ev("opencode:other", "session.started", { title: "other", workspace: "/tmp/x" }, "2026-01-02T00:00:00Z"),
      ev("opencode:other", "turn.user", { turn_id: "t9", content: [{ type: "text", text: "scrollTop lives here too" }] }, "2026-01-02T00:00:01Z"),
    ]);
    const res = await fetch(`${base}/sessions/${encodeURIComponent(sid)}/search?q=scrollTop`).then((r) => r.json());
    expect(res.more).toBe(false);
    expect(res.hits.length).toBe(3);
    const byType = Object.fromEntries(res.hits.map((h: { type: string }) => [h.type, h]));
    expect(byType["turn.assistant"].turn_id).toBe("t1");
    expect(byType["tool.call"].turn_id).toBe("t2");
    expect(byType["tool.result"].turn_id).toBeNull();
    expect(byType["tool.result"].call_id).toBe("c1");
    expect(res.hits.every((h: { turn_id: string | null; call_id: string | null }) => h.turn_id || h.call_id)).toBe(true);
    expect(byType["tool.result"].snippet).toContain("[scrollTop]");
    const capped = await fetch(`${base}/sessions/${encodeURIComponent(sid)}/search?q=scrollTop&limit=2`).then((r) => r.json());
    expect(capped.hits.length).toBe(2);
    expect(capped.more).toBe(true);
    const empty = await fetch(`${base}/sessions/${encodeURIComponent(sid)}/search?q=nothingmatchesthis`).then((r) => r.json());
    expect(empty.hits).toEqual([]);
    svc.stop();
  });

  test("a child session is kept under its parent", async () => {
    const root = { id: "root", title: "Parent", directory: "/repo", time: { created: 1, updated: 1 } };
    const kid = { id: "kid", parentID: "root", title: "Child", directory: "/repo", time: { created: 2, updated: 2 } };
    const oc = fakeOpencode({
      "/session": () => Response.json([root]),
      "/session/root/children": () => Response.json([kid]),
      "/session/kid/children": () => Response.json([]),
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const connected = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });
    expect(connected.status).toBe(200);
    const list = (await fetch(`${base}/sessions`).then((r) => r.json())) as {
      sessions: { summary: { session_id: string }; parent?: string; title?: string }[];
    };
    const child = list.sessions.find((s) => s.summary.session_id === "opencode:kid");
    expect(child?.parent).toBe("opencode:root");
    expect(child?.title).toBe("Child");
    oc.stop();
    svc.stop();
  });

  test("an OpenCode session can revert, restore, fork, and summarize", async () => {
    const oc = fakeOpencode({
      "/session/ses_x/revert": () => Response.json({ id: "ses_x", directory: "/repo", title: "x", time: { created: 1, updated: 1 } }),
      "/session/ses_x/unrevert": () => Response.json({ id: "ses_x", directory: "/repo", title: "x", time: { created: 1, updated: 1 } }),
      "/session/ses_x/fork": () => Response.json({ id: "ses_fork", directory: "/repo", title: "fork", time: { created: 1, updated: 1 } }),
      "/session/ses_fork": () => Response.json({ id: "ses_fork", directory: "/repo", title: "x (fork #3)", time: { created: 1, updated: 1 } }),
      "/session/ses_x/summarize": () => Response.json(true),
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (p: string, body?: unknown) => fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await post("/connect", { baseUrl: oc.baseUrl, directory: "/repo" });
    svc.store.append([
      ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z"),
      ev("opencode:ses_x", "turn.user", { turn_id: "msg_1", content: [{ type: "text", text: "a" }] }, "2026-01-01T00:00:01Z"),
      ev("opencode:ses_x", "turn.assistant", { turn_id: "msg_1", msg_id: "msg_1r", content: [] }, "2026-01-01T00:00:02Z"),
      ev("opencode:ses_x", "turn.user", { turn_id: "msg_2", content: [{ type: "text", text: "b" }] }, "2026-01-01T00:00:03Z"),
      ev("opencode:ses_y", "session.started", { title: "x (fork #2)", workspace: "/repo" }, "2026-01-01T00:00:04Z"),
    ]);
    const sid = encodeURIComponent("opencode:ses_x");
    expect(await fetch(`${base}/sessions/${sid}/capabilities`).then((r) => r.json())).toMatchObject({
      connected: true, revert: true, fork: true, summarize: true,
    });
    expect((await post(`/sessions/${sid}/revert`, {})).status).toBe(400);
    expect((await post(`/sessions/${sid}/revert`, { message_id: "" })).status).toBe(400);
    const revert = await post(`/sessions/${sid}/revert`, { message_id: "msg_1" });
    expect(revert.status).toBe(200);
    expect(await revert.json()).toEqual({ ok: true });
    const revertSeen = oc.seen.filter((s) => s.path === "/session/ses_x/revert").at(-1);
    expect(JSON.parse(revertSeen!.body)).toEqual({ messageID: "msg_1" });
    const unrevert = await post(`/sessions/${sid}/unrevert`);
    expect(unrevert.status).toBe(200);
    expect(await unrevert.json()).toEqual({ ok: true });
    expect(oc.seen.some((s) => s.path === "/session/ses_x/unrevert")).toBe(true);
    expect((await post(`/sessions/${sid}/fork`, { message_id: "" })).status).toBe(400);
    expect((await post(`/sessions/${sid}/fork`, { message_id: "nope" })).status).toBe(400);
    const forkBody = () => JSON.parse(oc.seen.filter((s) => s.path === "/session/ses_x/fork").at(-1)!.body);
    const fork = await post(`/sessions/${sid}/fork`, { message_id: "msg_1" });
    expect(fork.status).toBe(200);
    expect(await fork.json()).toEqual({ id: "opencode:ses_fork" });
    expect(forkBody()).toEqual({ messageID: "msg_1" });
    const renamed = oc.seen.filter((s) => s.path === "/session/ses_fork" && s.method === "PATCH").at(-1);
    expect(JSON.parse(renamed!.body)).toMatchObject({ title: "x (fork #3)" });
    expect((await post(`/sessions/${sid}/fork`, { message_id: "msg_1r", through: true })).status).toBe(200);
    expect(forkBody()).toEqual({ messageID: "msg_2" });
    expect((await post(`/sessions/${sid}/fork`, {})).status).toBe(200);
    expect(forkBody()).toEqual({});
    const summarize = await post(`/sessions/${sid}/summarize`);
    expect(summarize.status).toBe(200);
    expect(await summarize.json()).toEqual({ ok: true });
    expect(oc.seen.some((s) => s.path === "/session/ses_x/summarize")).toBe(true);
    const modeled = await post(`/sessions/${sid}/summarize`, { model: { providerID: "openai", modelID: "gpt-5" } });
    expect(modeled.status).toBe(200);
    const modeledSeen = oc.seen.filter((s) => s.path === "/session/ses_x/summarize").at(-1);
    expect(JSON.parse(modeledSeen!.body)).toMatchObject({ providerID: "openai", modelID: "gpt-5" });
    oc.stop();
    svc.stop();
  });

  test("a failed summarize is reported instead of a silent ok", async () => {
    const oc = fakeOpencode({
      "/session/ses_x/summarize": () => Response.json({ message: "model refused" }, { status: 400 }),
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });
    svc.store.append([ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z")]);
    const sid = encodeURIComponent("opencode:ses_x");
    const summarize = await fetch(`${base}/sessions/${sid}/summarize`, { method: "POST" });
    expect(summarize.status).toBe(502);
    expect(JSON.stringify(await summarize.json())).toContain("model refused");
    oc.stop();
    svc.stop();
  });

  test("a current OpenCode stages a revert, and a refusal is not a silent ok", async () => {
    const oc = fakeOpencode({ "/api/session/ses_x/revert/stage": () => Response.json({ data: { messageID: "msg_1" } }) });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });
    svc.store.append([ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z")]);
    const sid = encodeURIComponent("opencode:ses_x");
    const revert = await fetch(`${base}/sessions/${sid}/revert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message_id: "msg_1" }),
    });
    expect(revert.status).toBe(200);
    const staged = oc.seen.filter((s) => s.path === "/api/session/ses_x/revert/stage");
    expect(staged).toHaveLength(1);
    expect(JSON.parse(staged[0]!.body)).toEqual({ messageID: "msg_1" });
    expect(oc.seen.some((s) => s.path === "/session/ses_x/revert")).toBe(false);
    oc.stop();
    svc.stop();

    const refused = fakeOpencode({
      "/api/session/ses_x/revert/stage": () => Response.json({ message: "session is busy" }, { status: 409 }),
      "/session/ses_x/revert": () => Response.json(true),
    });
    const svc2 = startService({ db: ":memory:", port: 0 });
    const base2 = `http://127.0.0.1:${svc2.port}`;
    await fetch(`${base2}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: refused.baseUrl, directory: "/repo" }),
    });
    svc2.store.append([ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z")]);
    const denied = await fetch(`${base2}/sessions/${sid}/revert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message_id: "msg_1" }),
    });
    expect(denied.status).toBe(502);
    expect(JSON.stringify(await denied.json())).toContain("session is busy");
    expect(refused.seen.some((s) => s.path === "/session/ses_x/revert")).toBe(false);
    refused.stop();
    svc2.stop();

    const restored = fakeOpencode({
      "/api/session/ses_x/revert": (_url, req) =>
        req.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ error: "not found" }, { status: 404 }),
    });
    const svc3 = startService({ db: ":memory:", port: 0 });
    const base3 = `http://127.0.0.1:${svc3.port}`;
    await fetch(`${base3}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: restored.baseUrl, directory: "/repo" }),
    });
    svc3.store.append([ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z")]);
    const undo = await fetch(`${base3}/sessions/${sid}/unrevert`, { method: "POST" });
    expect(undo.status).toBe(200);
    expect(restored.seen.some((s) => s.path === "/api/session/ses_x/revert" && s.method === "DELETE")).toBe(true);
    expect(restored.seen.some((s) => s.path === "/session/ses_x/unrevert")).toBe(false);
    restored.stop();
    svc3.stop();
  });
});
