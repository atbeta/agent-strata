import { describe, expect, test } from "bun:test";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { OPENCODE_REBUILT_TYPES } from "@agent-strata/adapter-opencode";
import { goalIsMet, shouldContinueGoal } from "../src/goal";
import { startService } from "../src/index";
import { fakeOpencode } from "./fake-opencode";

describe("whether a goal should continue", () => {
  const ready = {
    goal: "ship it",
    busy: false,
    status: "active" as const,
    pending: false,
    paused: false,
    kicked: false,
  };

  test("an idle session with a goal continues, and a met one does not", () => {
    expect(shouldContinueGoal(ready)).toBe(true);
    expect(shouldContinueGoal({ ...ready, goal: undefined })).toBe(false);
    expect(shouldContinueGoal({ ...ready, busy: true })).toBe(false);
    expect(shouldContinueGoal({ ...ready, paused: true })).toBe(false);
    expect(shouldContinueGoal({ ...ready, kicked: true })).toBe(false);
    expect(shouldContinueGoal({ ...ready, pending: true })).toBe(false);
    expect(shouldContinueGoal({ ...ready, status: "completed" })).toBe(false);
    expect(shouldContinueGoal({ ...ready, lastAssistant: "done\nGOAL MET" })).toBe(false);
    expect(goalIsMet("GOAL MET")).toBe(true);
    expect(goalIsMet("not yet")).toBe(false);
  });
});

describe("a goal continues the session when it goes idle", () => {
  const sid = "opencode:ses_g";

  async function boot() {
    const upstream = fakeOpencode({
      "/session/ses_g/prompt_async": () => new Response(null, { status: 204 }),
      "/session/ses_g/abort": () => new Response(null, { status: 200 }),
    });
    const prompts = () => upstream.seen.filter((s) => s.path === "/session/ses_g/prompt_async");
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    await post("/connect", { baseUrl: upstream.baseUrl, directory: "/conn" });
    svc.store.append([
      makeEvent({
        session_id: sid,
        type: "session.started",
        ts: "2026-01-01T00:00:00Z",
        source: { backend: "opencode" },
        data: { title: "g", workspace: "/repo" },
      } as EventInput),
    ]);
    const goal = (method: "PUT" | "DELETE", text?: string) =>
      fetch(`${base}/sessions/${encodeURIComponent(sid)}/goal`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "PUT" ? JSON.stringify({ text }) : undefined,
      });
    const waitFor = async (n: number) => {
      for (let i = 0; i < 40 && prompts().length < n; i++) await Bun.sleep(15);
    };
    return {
      prompts,
      waitFor,
      goal,
      post,
      base,
      stop() {
        svc.stop();
        upstream.stop();
      },
      append(type: EventInput["type"], data: Record<string, unknown>, ts: string) {
        svc.store.append([
          makeEvent({
            session_id: sid,
            type,
            ts,
            source: { backend: "opencode" },
            data,
          } as EventInput),
        ]);
      },
      rebuild() {
        svc.sink.replaceSession(
          sid,
          [
            makeEvent({
              session_id: sid,
              type: "session.started",
              ts: "2026-01-01T00:00:10Z",
              source: { backend: "opencode" },
              data: { title: "g", workspace: "/repo" },
            } as EventInput),
          ],
          { replaceTypes: OPENCODE_REBUILT_TYPES },
        );
      },
      view: () => fetch(`${base}/sessions/${encodeURIComponent(sid)}/view`).then((r) => r.json()),
    };
  }

  test("setting a goal on an idle session sends one continuation, and a second idle does not", async () => {
    const run = await boot();
    const res = await run.goal("PUT", "ship the fix");
    expect(res.status).toBe(200);
    await run.waitFor(1);
    expect(run.prompts()).toHaveLength(1);
    expect(run.prompts()[0]!.body).toContain("ship the fix");
    expect(run.prompts()[0]!.body).toContain("GOAL MET");
    run.append("session.status", { state: "idle" }, "2026-01-01T00:00:01Z");
    expect(run.prompts()).toHaveLength(1);
    run.stop();
  });

  test("busy then idle sends the next step, and GOAL MET stops it", async () => {
    const run = await boot();
    await run.goal("PUT", "ship the fix");
    await run.waitFor(1);
    run.append("session.status", { state: "busy" }, "2026-01-01T00:00:02Z");
    run.append("session.status", { state: "idle" }, "2026-01-01T00:00:03Z");
    await run.waitFor(2);
    expect(run.prompts()).toHaveLength(2);
    run.append(
      "turn.assistant",
      { turn_id: "t-met", content: [{ type: "text", text: "GOAL MET" }] },
      "2026-01-01T00:00:04Z",
    );
    run.append("session.status", { state: "busy" }, "2026-01-01T00:00:05Z");
    run.append("session.status", { state: "idle" }, "2026-01-01T00:00:06Z");
    expect(run.prompts()).toHaveLength(2);
    run.stop();
  });

  test("an abort holds the goal until the user sends their own prompt", async () => {
    const run = await boot();
    await run.goal("PUT", "ship the fix");
    await run.waitFor(1);
    expect((await run.post(`/sessions/${encodeURIComponent(sid)}/abort`)).status).toBe(200);
    run.append("session.status", { state: "idle" }, "2026-01-01T00:00:07Z");
    await Bun.sleep(50);
    expect(run.prompts()).toHaveLength(1);
    expect((await run.post(`/sessions/${encodeURIComponent(sid)}/prompt`, { text: "keep going" })).status).toBe(200);
    run.append("session.status", { state: "busy" }, "2026-01-01T00:00:08Z");
    run.append("session.status", { state: "idle" }, "2026-01-01T00:00:09Z");
    await run.waitFor(3);
    expect(run.prompts()).toHaveLength(3);
    expect(run.prompts().at(-1)!.body).toContain("ship the fix");
    expect(await fetch(`${run.base}/sessions/${encodeURIComponent(sid)}/goal`).then((r) => r.json())).toMatchObject({
      text: "ship the fix",
    });
    run.stop();
  });

  test("clearing the goal stops it, and a rebuild does not drop it while it is set", async () => {
    const run = await boot();
    await run.goal("PUT", "ship the fix");
    await run.waitFor(1);
    expect((await run.view()).goal).toBe("ship the fix");
    run.rebuild();
    expect(OPENCODE_REBUILT_TYPES).not.toContain("session.goal");
    expect((await run.view()).goal).toBe("ship the fix");
    expect((await run.goal("DELETE")).status).toBe(200);
    expect((await run.view()).goal).toBeUndefined();
    run.append("session.status", { state: "busy" }, "2026-01-01T00:00:11Z");
    run.append("session.status", { state: "idle" }, "2026-01-01T00:00:12Z");
    await Bun.sleep(40);
    expect(run.prompts().filter((s) => s.body.includes("ship the fix"))).toHaveLength(1);
    run.stop();
  });

  test("a blank goal is refused", async () => {
    const run = await boot();
    expect((await run.goal("PUT", "   ")).status).toBe(400);
    run.stop();
  });
});
