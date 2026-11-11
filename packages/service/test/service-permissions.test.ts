import { describe, expect, test } from "bun:test";
import { startService } from "../src/index";
import { fakeOpencode } from "./fake-opencode";
import { ev } from "./service-harness";

describe("permission and question behavior", () => {
  test("a session waiting on the user is marked, and always is what OpenCode is told", async () => {
    const oc = fakeOpencode({
      "/permission/perm1/reply": async (_url, req) => {
        await req.json();
        return Response.json(true);
      },
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (p: string, body: unknown) =>
      fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await post("/connect", { baseUrl: oc.baseUrl, directory: "/repo" });

    const before = await fetch(`${base}/sessions`).then((r) => r.json());
    expect(before.sessions.every((s: { needs_input?: boolean }) => s.needs_input === false)).toBe(true);

    oc.push({
      directory: "/repo",
      payload: {
        type: "permission.asked",
        properties: { id: "perm1", sessionID: "ses_wait", permission: "bash", patterns: ["ls"], metadata: {}, always: ["ls"] },
      },
    });
    let marked = false;
    for (let i = 0; i < 20 && !marked; i++) {
      await Bun.sleep(50);
      const list = (await fetch(`${base}/sessions`).then((r) => r.json())) as {
        sessions: { summary: { session_id: string }; needs_input?: boolean }[];
      };
      marked = list.sessions.some((s) => s.summary.session_id === "opencode:ses_wait" && s.needs_input === true);
    }
    expect(marked).toBe(true);

    expect((await post("/permissions/perm1/respond", { decision: "allow", scope: "always" })).status).toBe(200);
    let reply: (typeof oc.seen)[number] | undefined;
    for (let i = 0; i < 20 && !reply; i++) {
      reply = oc.seen.find((s) => s.path === "/permission/perm1/reply");
      if (!reply) await Bun.sleep(50);
    }
    expect(JSON.parse(reply!.body).reply).toBe("always");

    const after = (await fetch(`${base}/sessions`).then((r) => r.json())) as {
      sessions: { summary: { session_id: string }; needs_input?: boolean }[];
    };
    expect(after.sessions.find((s) => s.summary.session_id === "opencode:ses_wait")?.needs_input).toBe(false);
    oc.stop();
    svc.stop();
  });

  test("a permission OpenCode already answered leaves the pending list", async () => {
    const oc = fakeOpencode({});
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });
    oc.push({
      directory: "/repo",
      payload: {
        type: "permission.asked",
        properties: { id: "perm-done", sessionID: "ses_done", permission: "bash", patterns: ["ls"], metadata: {}, always: [] },
      },
    });
    let pending = false;
    for (let i = 0; i < 20 && !pending; i++) {
      await Bun.sleep(50);
      const body = (await fetch(`${base}/permissions`).then((r) => r.json())) as { pending: { request_id: string }[] };
      pending = body.pending.some((p) => p.request_id === "perm-done");
    }
    expect(pending).toBe(true);
    oc.push({
      directory: "/repo",
      payload: { type: "permission.replied", properties: { sessionID: "ses_done", requestID: "perm-done", reply: "once" } },
    });
    let cleared = false;
    for (let i = 0; i < 20 && !cleared; i++) {
      await Bun.sleep(50);
      const body = (await fetch(`${base}/permissions`).then((r) => r.json())) as { pending: { request_id: string }[] };
      cleared = !body.pending.some((p) => p.request_id === "perm-done");
    }
    expect(cleared).toBe(true);
    oc.stop();
    svc.stop();
  });
});

describe("a question outlives the process that received it", () => {
  const seedQuestion = (svc: ReturnType<typeof startService>, sessionId: string, requestId: string) =>
    svc.store.append([
      ev(sessionId, "question.asked", {
        request_id: requestId,
        questions: [{ question: "Which approach?", header: "Approach", options: [{ label: "A", description: "split" }, { label: "B", description: "keep" }] }],
      }, "2026-01-01T00:00:05Z"),
    ]);

  test("/questions lists it, and the session is marked as waiting", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    seedQuestion(svc, "opencode:s1", "que_restart");

    const { pending } = await fetch(`${base}/questions`).then((r) => r.json());
    expect(pending).toHaveLength(1);
    expect(pending[0].request_id).toBe("que_restart");
    expect(pending[0].session_id).toBe("opencode:s1");

    const sessions = await fetch(`${base}/sessions`).then((r) => r.json());
    const row = sessions.sessions.find((s: { summary: { session_id: string } }) => s.summary.session_id === "opencode:s1");
    expect(row.needs_input).toBe(true);
    svc.stop();
  });

  test("answering it succeeds and retires the card", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    seedQuestion(svc, "opencode:s1", "que_restart");

    const res = await fetch(`${base}/questions/que_restart/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reply", answers: [["A"]] }),
    });
    expect(res.status).toBe(200);

    const { pending } = await fetch(`${base}/questions`).then((r) => r.json());
    expect(pending).toEqual([]);

    const sessions = await fetch(`${base}/sessions`).then((r) => r.json());
    const row = sessions.sessions.find((s: { summary: { session_id: string } }) => s.summary.session_id === "opencode:s1");
    expect(row.needs_input).toBe(false);
    svc.stop();
  });

  test("a question that is still unknown is a 404, not a silent success", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const res = await fetch(`${base}/questions/que_never/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reply", answers: [["A"]] }),
    });
    expect(res.status).toBe(404);
    svc.stop();
  });
});
