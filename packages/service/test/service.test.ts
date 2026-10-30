import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createIngestor, OpencodeMapper, OPENCODE_MAPPER_VERSION } from "@agent-strata/adapter-opencode";
import { startService } from "../src/index";
import { makeEvent, type EventInput, type Event } from "@agent-strata/schema";
import { fakeOpencode } from "./fake-opencode";

const ev = (
  sessionId: string,
  type: EventInput["type"],
  data: Record<string, unknown>,
  ts: string,
): EventInput =>
  makeEvent({
    session_id: sessionId,
    type,
    ts,
    source: { backend: "opencode" },
    data,
  } as EventInput);

const seed = (svc: ReturnType<typeof startService>, sessionId = "opencode:s1") => {
  svc.store.append([
    ev(sessionId, "session.started", { title: "seed", workspace: "/tmp/x" }, "2026-01-01T00:00:00Z"),
    ev(
      sessionId,
      "turn.user",
      { turn_id: "t1", content: [{ type: "text", text: "hello" }] },
      "2026-01-01T00:00:01Z",
    ),
    ev(
      sessionId,
      "turn.assistant",
      {
        turn_id: "t1",
        model: "deepseek/deepseek-flash",
        usage: { input: 10, output: 5 },
        cost_usd: 0.001,
        latency_ms: 100,
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
      },
      "2026-01-01T00:00:02Z",
    ),
  ]);
};

describe("agent-strata service", () => {
  test("a session the ingestor watched being created carries the mapper version", () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const ing = createIngestor({ mapper: new OpencodeMapper(), sink: svc.sink, reply: async () => {} });
    const created = (id: string, sessionID: string) =>
      ({
        id,
        type: "session.created",
        properties: {
          sessionID,
          info: { id: sessionID, directory: "/repo", title: "T", time: { created: 1, updated: 1 } },
        },
      }) as unknown as Parameters<typeof ing.handle>[0];
    ing.handle(created("evt_1", "ses_live"));
    ing.handle(created("import:ses_old", "ses_old"));
    expect(svc.store.sessionMapper("opencode:ses_live")).toBe(OPENCODE_MAPPER_VERSION);
    expect(svc.store.sessionMapper("opencode:ses_old")).toBeNull();
    ing.stop();
    svc.stop();
  });

  test("markMapped records the first mapper and leaves it", () => {
    const svc = startService({ db: ":memory:", port: 0 });
    seed(svc, "opencode:born");
    expect(svc.store.sessionMapper("opencode:born")).toBeNull();
    svc.sink.markMapped("opencode:born", "opencode-3");
    expect(svc.store.sessionMapper("opencode:born")).toBe("opencode-3");
    svc.sink.markMapped("opencode:born", "opencode-2");
    expect(svc.store.sessionMapper("opencode:born")).toBe("opencode-3");
    svc.stop();
  });

  test("a tail view carries the last turns and leaves out files the reader already has", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const sid = "opencode:tail";
    seed(svc, sid);
    svc.store.append([
      ev(sid, "turn.user", { turn_id: "t2", content: [{ type: "text", text: "second" }] }, "2026-01-01T00:00:03Z"),
      ev(sid, "tool.call", { turn_id: "t2", call_id: "c1", tool: "edit", input: { filePath: "/tmp/x/a.ts" } }, "2026-01-01T00:00:04Z"),
      ev(sid, "file.changed", { path: "/tmp/x/a.ts", change: "modify", diff: "@@ -1 +1 @@\n-a\n+b\n", call_id: "c1" }, "2026-01-01T00:00:05Z"),
    ]);
    const view = (q: string) => fetch(`${base}/sessions/${encodeURIComponent(sid)}/view${q}`).then((r) => r.json());

    const full = await view("");
    const tail = await view("?tail=1");
    expect(tail.turns.map((t: { turn_id: string }) => t.turn_id)).toEqual(["t2"]);
    expect(tail.turn_offset).toBe(1);
    expect(tail.prev_turn_id).toBe("t1");
    expect(tail.totals).toEqual(full.totals);
    expect(tail.files_changed).toEqual(full.files_changed);
    expect(typeof tail.files_key).toBe("string");

    const again = await view(`?tail=1&files_key=${encodeURIComponent(tail.files_key)}`);
    expect(again.files_changed).toBeUndefined();
    expect(again.turns.map((t: { turn_id: string }) => t.turn_id)).toEqual(["t2"]);
    expect((await view("?tail=1&files_key=0:0")).files_changed).toEqual(full.files_changed);
    expect((await view("?tail=0")).turns).toHaveLength(1);

    const all = await view("?tail=10");
    expect(all.turn_offset).toBe(0);
    expect(all.prev_turn_id).toBeNull();
    expect(all.turns).toHaveLength(2);

    svc.stop();
  });

  test("a message still being written shows in the view until the finished one lands", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const sid = "opencode:live1";
    seed(svc, sid);
    const view = () => fetch(`${base}/sessions/${encodeURIComponent(sid)}/view`).then((r) => r.json());

    svc.sink.publish([
      ev(sid, "turn.assistant", { turn_id: "t2", msg_id: "m2", partial: true, content: [{ type: "text", text: "wri" }] }, "2026-01-01T00:00:05Z"),
    ]);
    let v = await view();
    expect(v.turns.at(-1).assistant[0]).toMatchObject({ msg_id: "m2", partial: true });
    expect(svc.store.read({ session_id: sid })).toHaveLength(3);

    svc.store.append([
      ev(sid, "turn.assistant", { turn_id: "t2", msg_id: "m2", content: [{ type: "text", text: "written" }] }, "2026-01-01T00:00:06Z"),
    ]);
    v = await view();
    expect(v.turns.at(-1).assistant).toHaveLength(1);
    expect(v.turns.at(-1).assistant[0].content[0].text).toBe("written");
    expect(v.turns.at(-1).assistant[0].partial).toBeUndefined();

    // a message that never finished is dropped once the session goes idle
    svc.sink.publish([
      ev(sid, "turn.assistant", { turn_id: "t3", msg_id: "m3", partial: true, content: [{ type: "text", text: "lost" }] }, "2026-01-01T00:00:07Z"),
    ]);
    expect((await view()).turns.some((t: { turn_id: string }) => t.turn_id === "t3")).toBe(true);
    svc.store.append([ev(sid, "session.status", { state: "idle" }, "2026-01-01T00:00:08Z")]);
    expect((await view()).turns.some((t: { turn_id: string }) => t.turn_id === "t3")).toBe(false);

    svc.stop();
  });

  test("views follow appends and rebuilds, and the list projects each session once", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const sid = "opencode:cached";
    seed(svc, sid);
    const view = () => fetch(`${base}/sessions/${encodeURIComponent(sid)}/view`).then((r) => r.json());
    expect((await view()).totals.input).toBe(10);

    svc.store.append([
      ev(sid, "turn.assistant", { turn_id: "t1", msg_id: "m9", usage: { input: 5, output: 1 }, content: [] }, "2026-01-01T00:00:03Z"),
    ]);
    expect((await view()).totals.input).toBe(15);

    svc.sink.replaceSession(
      sid,
      [ev(sid, "turn.assistant", { turn_id: "t1", usage: { input: 1, output: 1 }, content: [] }, "2026-01-01T00:00:04Z")],
      { replaceTypes: ["turn.assistant"] },
    );
    expect((await view()).totals.input).toBe(1);

    const list = await fetch(`${base}/sessions`).then((r) => r.json());
    expect(list.sessions[0].totals.input).toBe(1);
    expect(list.aggregate.total.input).toBe(1);
    svc.stop();
  });

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
    const acpCaps = (await fetch(`${base}/sessions/${encodeURIComponent(created.id)}/capabilities`).then((r) =>
      r.json(),
    )) as Record<string, unknown>;
    expect(acpCaps.revert).toBeUndefined();
    expect(acpCaps.fork).toBeUndefined();
    expect(acpCaps.summarize).toBeUndefined();
    expect((await post(`/sessions/${encodeURIComponent(created.id)}/revert`, { message_id: "m1" })).status).toBe(400);
    expect(
      (await post(`/sessions/${encodeURIComponent(created.id)}/mcp/${encodeURIComponent("srv")}/disconnect`, {})).status,
    ).toBe(400);

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

    // `opencode acp` names itself opencode, so its sessions are the same ones
    // `opencode serve` lists over HTTP — the case that used to show up twice.
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

    // the HTTP channel replays the same session through the shared sink
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

    // a rebuild must not sneak the same session in under the other id
    expect(
      svc.sink.replaceSession(shadow, [httpSays], { replaceTypes: ["session.started"] }),
    ).toBe(0);

    // a different agent that happens to reuse the id is a different session
    svc.sink.append([
      makeEvent({
        session_id: `acp:claude-code:${native}`,
        source: { backend: "acp", agent: "claude-code", native_id: native },
        type: "session.started",
        data: { workspace: "/tmp" },
      } as EventInput),
    ]);
    expect(await sessionIds()).toEqual([`acp:claude-code:${native}`, created.id].sort());

    // once the owning connection is gone the layer may import the session again
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
    const preflight = await fetch(`${base}/connect`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);

    const sync = await fetch(`${base}/sync`, { method: "POST" }).then((r) => r.json());
    expect(sync).toEqual({ connected: false, imported: 0, reconciled: 0 });

    seed(svc);
    seed(svc, "opencode:s2");

    const sessions = await fetch(`${base}/sessions`).then((r) => r.json());
    expect(sessions.sessions.length).toBe(2);
    expect(sessions.aggregate.total.cost_usd).toBeCloseTo(0.002);

    const events = await fetch(
      `${base}/events?session_id=opencode:s1&types=turn.user`,
    ).then((r) => r.json());
    expect(events.events.length).toBe(1);
    expect(events.events[0].type).toBe("turn.user");

    const text = await fetch(`${base}/events?text=hello`).then((r) => r.json());
    expect(text.events.length).toBe(2);

    const badCursor = await fetch(`${base}/events?after_seq=abc`);
    expect(badCursor.status).toBe(400);

    const view = await fetch(`${base}/sessions/opencode:s1/view`).then((r) => r.json());
    expect(view.totals.input).toBe(10);
    expect(view.status).toBe("active");

    // replay: until_seq projects only the prefix
    const at2 = await fetch(`${base}/sessions/opencode:s1/view?until_seq=2`).then((r) =>
      r.json(),
    );
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

    const abort = await fetch(`${base}/sessions/opencode:s1/abort`, { method: "POST" });
    expect(abort.status).toBe(400);

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

  test("policy endpoints: get/put/test/delete + file persistence", async () => {
    const dir = `${import.meta.dir}/.tmp-${Bun.randomUUIDv7()}`;
    const svc = startService({
      db: ":memory:",
      port: 0,
      policyFile: `${dir}/policy.json`,
    });
    const base = `http://127.0.0.1:${svc.port}`;

    const empty = await fetch(`${base}/policy`).then((r) => r.json());
    expect(empty.policy).toBeNull();

    const noPolicy = await fetch(`${base}/policy/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "bash", input: { command: "rm -rf /" } }),
    }).then((r) => r.json());
    expect(noPolicy.decision).toBe("ask");

    const bad = await fetch(`${base}/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        rules: [{ id: "x", effect: "allow", tool: "*", when: { c: { matches: "[" } } }],
      }),
    });
    expect(bad.status).toBe(400);

    const policy = {
      version: 1,
      default: "ask",
      rules: [
        { id: "deny-rm", effect: "deny", tool: "bash", when: { command: { matches: "\\brm\\b" } } },
        { id: "allow-read", effect: "allow", tool: "read" },
      ],
    };
    const put = await fetch(`${base}/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(policy),
    });
    expect(put.status).toBe(200);

    const got = await fetch(`${base}/policy`).then((r) => r.json());
    expect(got.policy.rules.length).toBe(2);
    expect(got.file).toBe(`${dir}/policy.json`);

    const denied = await fetch(`${base}/policy/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "bash", input: { command: "rm -rf /tmp/x" } }),
    }).then((r) => r.json());
    expect(denied).toMatchObject({ decision: "deny", rule_id: "deny-rm" });

    // inline draft policy overrides the live one without saving it
    const draft = await fetch(`${base}/policy/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        tool: "bash",
        input: { command: "rm -rf /tmp/x" },
        policy: { version: 1, rules: [{ id: "yolo", effect: "allow", tool: "*" }] },
      }),
    }).then((r) => r.json());
    expect(draft).toMatchObject({ decision: "allow", rule_id: "yolo" });

    // a fresh service over the same file loads the persisted policy
    const svc2 = startService({ db: ":memory:", port: 0, policyFile: `${dir}/policy.json` });
    const got2 = await fetch(`http://127.0.0.1:${svc2.port}/policy`).then((r) => r.json());
    expect(got2.policy.rules.length).toBe(2);
    svc2.stop();

    const del = await fetch(`${base}/policy`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await fetch(`${base}/policy`).then((r) => r.json())).policy).toBeNull();

    svc.stop();
    const svc3 = startService({ db: ":memory:", port: 0, policyFile: `${dir}/policy.json` });
    expect((await fetch(`http://127.0.0.1:${svc3.port}/policy`).then((r) => r.json())).policy).toBeNull();
    svc3.stop();
  });

  test("one session stops asking, and only that one", async () => {
    // The whole point of the switch: the same permission at the same moment on
    // two sessions of one connection — one answered by the policy, one still
    // held for the reader. Anything less scoped than this is the shared policy
    // editor wearing a different label.
    const oc = fakeOpencode({
      "/permission/p-auto/reply": () => Response.json(true),
      "/permission/p-back/reply": () => Response.json(true),
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const put = (u: string, b: unknown) =>
      fetch(u, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    const asked = (id: string) =>
      oc.seen.find((s) => s.path === `/permission/${id}/reply`);
    const pendingIds = async () =>
      (await fetch(`${base}/permissions`).then((r) => r.json())).pending.map(
        (p: { request_id: string }) => p.request_id,
      );
    const ask = (id: string, sessionID: string) =>
      oc.push({
        directory: "/repo",
        payload: {
          type: "permission.asked",
          properties: {
            id, sessionID, permission: "bash", patterns: ["ls"], metadata: {}, always: [],
          },
        },
      });

    // A shared policy that answers one tool and defers everything else.
    await put(`${base}/policy`, {
      version: 1,
      default: "ask",
      rules: [{ id: "allow-read", effect: "allow", tool: "read" }],
    });
    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });

    // Off by default, and said so.
    expect((await fetch(`${base}/sessions/opencode%3Ases_auto/policy`).then((r) => r.json())).mode).toBe("inherit");

    await put(`${base}/sessions/opencode%3Ases_auto/policy`, { mode: "auto" });
    expect((await fetch(`${base}/sessions/opencode%3Ases_auto/policy`).then((r) => r.json())).mode).toBe("auto");
    const bad = await fetch(`${base}/sessions/opencode%3Ases_auto/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "yolo" }),
    });
    expect(bad.status).toBe(400);

    ask("p-auto", "ses_auto");
    ask("p-other", "ses_other");
    for (let i = 0; i < 30 && !(asked("p-auto") && (await pendingIds()).includes("p-other")); i++) {
      await Bun.sleep(50);
    }
    // The switched session was answered on its own; the other one is still
    // waiting for a reader, which is what "one session" has to mean.
    expect(asked("p-auto")).toBeDefined();
    expect(JSON.parse(asked("p-auto")!.body).reply).toBe("once");
    expect(await pendingIds()).toContain("p-other");

    // Switching back asks again, in the very session that was on auto.
    await fetch(`${base}/sessions/opencode%3Ases_auto/policy`, { method: "DELETE" });
    expect((await fetch(`${base}/sessions/opencode%3Ases_auto/policy`).then((r) => r.json())).mode).toBe("inherit");
    ask("p-back", "ses_auto");
    for (let i = 0; i < 30 && !(await pendingIds()).includes("p-back"); i++) await Bun.sleep(50);
    expect(await pendingIds()).toContain("p-back");

    // A session nobody has met is reported unknown rather than pretended.
    expect((await fetch(`${base}/sessions/opencode%3Aghost/policy`).then((r) => r.json())).known).toBe(false);

    oc.stop();
    svc.stop();
  });

  test("a session on auto asks nothing when there is no shared policy", async () => {
    // autoStance never ran when the shared document was missing: base &&
    // stance short-circuited, the driver got undefined, and every ask
    // surfaced. The switch looked on and did nothing — the case behind
    // "not asking stopped working" with no rules configured.
    const oc = fakeOpencode({ "/permission/p-solo/reply": () => Response.json(true) });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const asked = (id: string) =>
      oc.seen.find((s) => s.path === `/permission/${id}/reply`);
    const pendingIds = async () =>
      (await fetch(`${base}/permissions`).then((r) => r.json())).pending.map(
        (p: { request_id: string }) => p.request_id,
      );

    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });
    await fetch(`${base}/sessions/opencode%3Ases_solo/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "auto" }),
    });

    oc.push({
      directory: "/repo",
      payload: {
        type: "permission.asked",
        properties: {
          id: "p-solo", sessionID: "ses_solo", permission: "bash", patterns: ["ls"], metadata: {}, always: [],
        },
      },
    });
    for (let i = 0; i < 30 && !asked("p-solo"); i++) await Bun.sleep(50);
    expect(asked("p-solo")).toBeDefined();
    expect(await pendingIds()).not.toContain("p-solo");

    oc.stop();
    svc.stop();
  });

  test("a session on auto is not stopped by the engine floor", async () => {
    // Redirects and unanalysable constructs are what the floor asks about —
    // and `cat > file <<EOF` is how an agent writes a file. Under the stance
    // that ask is the switch looking broken; the stance lifts the floor,
    // though a written `default: "allow"` still cannot.
    const oc = fakeOpencode({ "/permission/p-heredoc/reply": () => Response.json(true) });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const asked = (id: string) =>
      oc.seen.find((s) => s.path === `/permission/${id}/reply`);
    const pendingIds = async () =>
      (await fetch(`${base}/permissions`).then((r) => r.json())).pending.map(
        (p: { request_id: string }) => p.request_id,
      );

    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });
    await fetch(`${base}/sessions/opencode%3Ases_floor/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "auto" }),
    });

    oc.push({
      directory: "/repo",
      payload: {
        type: "permission.asked",
        properties: {
          id: "p-heredoc", sessionID: "ses_floor", permission: "bash",
          patterns: ["cat > /tmp/check.mjs <<'EOF'\nconsole.log(1)\nEOF"],
          metadata: {}, always: [],
        },
      },
    });
    for (let i = 0; i < 30 && !asked("p-heredoc"); i++) await Bun.sleep(50);
    expect(asked("p-heredoc")).toBeDefined();
    expect(JSON.parse(asked("p-heredoc")!.body).reply).toBe("once");
    expect(await pendingIds()).not.toContain("p-heredoc");

    oc.stop();
    svc.stop();
  });

  test("a session on auto still obeys a deny rule, and is not persisted", async () => {
    const oc = fakeOpencode({ "/permission/p-rm/reply": () => Response.json(true) });
    const dir = `${import.meta.dir}/.tmp-${Bun.randomUUIDv7()}`;
    const svc = startService({ db: ":memory:", port: 0, policyFile: `${dir}/policy.json` });
    const base = `http://127.0.0.1:${svc.port}`;
    await fetch(`${base}/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        default: "ask",
        rules: [{ id: "no-rm", effect: "deny", tool: "bash", when: { command: { matches: "^rm" } } }],
      }),
    });
    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });
    await fetch(`${base}/sessions/opencode%3Ases_s/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "auto" }),
    });
    // The rule the reader wrote still runs. Auto softens the fallback; it does
    // not replace the document, and it does not survive a restart — it is a
    // stance about a run in progress, not a setting for the machine.
    oc.push({
      directory: "/repo",
      payload: {
        type: "permission.asked",
        properties: {
          id: "p-rm", sessionID: "ses_s", permission: "bash",
          patterns: ["rm -rf /"], metadata: {}, always: [],
        },
      },
    });
    let reply: (typeof oc.seen)[number] | undefined;
    for (let i = 0; i < 30 && !reply; i++) {
      await Bun.sleep(50);
      reply = oc.seen.find((s) => s.path === "/permission/p-rm/reply");
    }
    expect(JSON.parse(reply!.body).reply).toBe("reject");
    oc.stop();
    svc.stop();

    const svc2 = startService({ db: ":memory:", port: 0, policyFile: `${dir}/policy.json` });
    expect(
      (await fetch(`http://127.0.0.1:${svc2.port}/sessions/opencode%3Ases_s/policy`).then((r) => r.json())).mode,
    ).toBe("inherit");
    svc2.stop();
  });

  test("a backend that is gone on boot is reported for opencode and acp alike", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-boot-gone-"));
    // The OpenCode address is probed once. The ACP command is the one boot
    // keeps retrying, and a missing executable fails without the stream timeout.
    writeFileSync(
      join(dir, "connections.json"),
      JSON.stringify([
        { baseUrl: "http://127.0.0.1:1" },
        { backend: "acp", command: "strata-no-such-agent", args: ["--nope"] },
      ]) + "\n",
    );
    const svc = startService({
      db: join(dir, "events.db"),
      port: 0,
      desktopDir: dir,
      autoConnectTimeoutMs: -1,
    });
    const base = `http://127.0.0.1:${svc.port}`;
    let body = { phase: "", attempts: [] as { endpoint: string; phase: string; backend: string }[] };
    for (let i = 0; i < 80; i++) {
      body = (await fetch(`${base}/connections`).then((r) => r.json())) as typeof body;
      if (body.phase === "failed" && body.attempts.length >= 2 && body.attempts.every((a) => a.phase === "failed")) break;
      await Bun.sleep(50);
    }
    expect(body.phase).toBe("failed");
    expect(body.attempts.map((a) => a.endpoint).sort()).toEqual([
      "acp://strata-no-such-agent --nope",
      "http://127.0.0.1:1",
    ]);
    expect(body.attempts.map((a) => a.backend).sort()).toEqual(["acp", "opencode"]);
    svc.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("forgetting a dead backend keeps it from being dialed again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-boot-forget-"));
    writeFileSync(
      join(dir, "connections.json"),
      JSON.stringify([{ baseUrl: "http://127.0.0.1:1" }, { backend: "acp", command: "strata-no-such-agent", args: ["--nope"] }]) +
        "\n",
    );
    const db = join(dir, "events.db");
    const first = startService({ db, port: 0, desktopDir: dir, autoConnectTimeoutMs: -1 });
    const base = `http://127.0.0.1:${first.port}`;
    let phase = "";
    for (let i = 0; i < 80 && phase !== "failed"; i++) {
      phase = ((await fetch(`${base}/connections`).then((r) => r.json())) as { phase: string }).phase;
      if (phase !== "failed") await Bun.sleep(50);
    }
    expect(phase).toBe("failed");
    for (const endpoint of ["http://127.0.0.1:1", "acp://strata-no-such-agent --nope"]) {
      const res = await fetch(`${base}/connections/forget`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint }),
      });
      expect(res.status).toBe(200);
    }
    const after = (await fetch(`${base}/connections`).then((r) => r.json())) as { phase: string; attempts: unknown[] };
    expect(after.attempts).toEqual([]);
    expect(after.phase).toBe("idle");
    expect(JSON.parse(readFileSync(join(dir, "connections.json"), "utf8"))).toEqual([]);
    first.stop();

    const second = startService({ db, port: 0, desktopDir: dir, autoConnectTimeoutMs: -1 });
    const again = (await fetch(`http://127.0.0.1:${second.port}/connections`).then((r) => r.json())) as {
      phase: string;
      attempts: unknown[];
    };
    expect(again.phase).toBe("idle");
    expect(again.attempts).toEqual([]);
    second.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a shorter reconnect does not report the boot target dead while boot is still trying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-boot-hold-"));
    writeFileSync(
      join(dir, "connections.json"),
      JSON.stringify([{ backend: "acp", command: "strata-no-such-agent", args: ["--nope"] }]) + "\n",
    );
    const svc = startService({
      db: join(dir, "events.db"),
      port: 0,
      desktopDir: dir,
      autoConnectTimeoutMs: 5_000,
    });
    const base = `http://127.0.0.1:${svc.port}`;
    const synced = await fetch(`${base}/sync`, { method: "POST" });
    expect(synced.status).toBe(200);
    const body = (await fetch(`${base}/connections`).then((r) => r.json())) as {
      phase: string;
      attempts: { phase: string; endpoint: string }[];
    };
    expect(body.phase).toBe("attaching");
    expect(body.attempts).toEqual([
      expect.objectContaining({ endpoint: "acp://strata-no-such-agent --nope", phase: "retrying" }),
    ]);
    svc.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an opencode connection says whether it is the embedded server", async () => {
    const oc = fakeOpencode();
    const desktopDir = mkdtempSync(join(tmpdir(), "strata-placement-"));
    writeFileSync(
      join(desktopDir, "opencode-status.json"),
      JSON.stringify({ state: "running", url: oc.baseUrl }),
    );
    const svc = startService({ db: ":memory:", port: 0, desktopDir });
    const base = `http://127.0.0.1:${svc.port}`;
    const connected = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl }),
    });
    expect(connected.status).toBe(200);
    const embedded = (await fetch(`${base}/connections`).then((r) => r.json())) as {
      phase: string;
      connections: { placement?: string; baseUrl: string }[];
    };
    expect(embedded.phase).toBe("connected");
    expect(embedded.connections[0]).toMatchObject({ baseUrl: oc.baseUrl, placement: "embed" });

    writeFileSync(join(desktopDir, "desktop.json"), JSON.stringify({ opencode: "external" }));
    const external = (await fetch(`${base}/connections`).then((r) => r.json())) as {
      connections: { placement?: string }[];
    };
    expect(external.connections[0]?.placement).toBe("external");

    writeFileSync(join(desktopDir, "desktop.json"), JSON.stringify({ opencode: "embed" }));
    writeFileSync(
      join(desktopDir, "opencode-status.json"),
      JSON.stringify({ state: "running", url: "http://127.0.0.1:9" }),
    );
    const other = (await fetch(`${base}/connections`).then((r) => r.json())) as {
      connections: { placement?: string }[];
    };
    expect(other.connections[0]?.placement).toBe("external");

    svc.stop();
    oc.stop();
    rmSync(desktopDir, { recursive: true, force: true });
  });

  test("autoConnect to a dead backend retries then gives up, service stays up", async () => {
    const svc = startService({
      db: ":memory:",
      port: 0,
      autoConnect: "http://127.0.0.1:1",
      autoConnectTimeoutMs: 400,
    });
    await Bun.sleep(600);
    const health = await fetch(`http://127.0.0.1:${svc.port}/health`).then((r) => r.json());
    expect(health.ok).toBe(true);
    expect(health.conns).toBe(0);
    svc.stop();
  });

  test("the embedded server of an earlier run is neither dialed nor remembered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-embed-boot-"));
    // The shape the shell gives the server it starts: loopback, the `opencode`
    // user, and a 43-character password.
    const stale = (port: number) => ({
      baseUrl: `http://127.0.0.1:${port}`,
      username: "opencode",
      password: "yachwVpceU13FftYteC9pU7Hq448RciEEgmflAWueNI",
    });
    writeFileSync(
      join(dir, "connections.json"),
      JSON.stringify([stale(53507), stale(51800), { baseUrl: "http://127.0.0.1:4096" }]) + "\n",
    );
    const svc = startService({
      db: join(dir, "events.db"),
      port: 0,
      desktopDir: dir,
      autoConnect: "http://127.0.0.1:64091",
      autoConnectPlacement: "embed",
      autoConnectTimeoutMs: -1,
    });
    const base = `http://127.0.0.1:${svc.port}`;
    let body = { attempts: [] as { endpoint: string }[] };
    for (let i = 0; i < 80; i++) {
      body = (await fetch(`${base}/connections`).then((r) => r.json())) as typeof body;
      const endpoints = body.attempts.map((a) => a.endpoint);
      if (endpoints.includes("http://127.0.0.1:64091") && !endpoints.includes("http://127.0.0.1:53507")) {
        break;
      }
      await Bun.sleep(50);
    }
    // The addresses of earlier runs are gone: they answered nobody, and a
    // dead address of the app's own server is not a backend to keep listing.
    // The address the user added themselves is still probed, and the one this
    // run owns is the only embedded address left in the list.
    expect(body.attempts.map((a) => a.endpoint).sort()).toEqual([
      "http://127.0.0.1:4096",
      "http://127.0.0.1:64091",
    ]);
    const saved = JSON.parse(readFileSync(join(dir, "connections.json"), "utf8")) as {
      baseUrl: string;
    }[];
    expect(saved.map((c) => c.baseUrl)).toEqual(["http://127.0.0.1:4096"]);
    svc.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("an address of the app's own shape that answers is kept", async () => {
    const oc = fakeOpencode();
    const dir = mkdtempSync(join(tmpdir(), "strata-embed-live-"));
    // The same shape the shell gives the server it starts — but a server that
    // is running, so it may be one the user runs themselves.
    writeFileSync(
      join(dir, "connections.json"),
      JSON.stringify([
        { baseUrl: oc.baseUrl, username: "opencode", password: "yachwVpceU13FftYteC9pU7Hq448RciEEgmflAWueNI" },
      ]) + "\n",
    );
    const svc = startService({
      db: join(dir, "events.db"),
      port: 0,
      desktopDir: dir,
      autoConnectTimeoutMs: -1,
    });
    const base = `http://127.0.0.1:${svc.port}`;
    let conns = 0;
    for (let i = 0; i < 80 && conns === 0; i++) {
      conns = (await fetch(`${base}/health`).then((r) => r.json())).conns;
      if (conns === 0) await Bun.sleep(50);
    }
    expect(conns).toBe(1);
    const saved = JSON.parse(readFileSync(join(dir, "connections.json"), "utf8")) as {
      baseUrl: string;
    }[];
    expect(saved.map((c) => c.baseUrl)).toEqual([oc.baseUrl]);
    svc.stop();
    oc.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a launch replaces the embedded address instead of adding one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "strata-embed-again-"));
    const db = join(dir, "events.db");
    const first = fakeOpencode();
    const second = fakeOpencode();
    const boot = async (url: string) => {
      const svc = startService({
        db,
        port: 0,
        desktopDir: dir,
        autoConnect: url,
        autoConnectPlacement: "embed",
        autoConnectTimeoutMs: -1,
      });
      for (let i = 0; i < 80; i++) {
        const health = (await fetch(`http://127.0.0.1:${svc.port}/health`).then((r) => r.json())) as {
          conns: number;
        };
        if (health.conns > 0) break;
        await Bun.sleep(50);
      }
      svc.stop();
    };
    await boot(first.baseUrl);
    await boot(second.baseUrl);

    const saved = JSON.parse(readFileSync(join(dir, "connections.json"), "utf8")) as {
      baseUrl?: string;
      placement?: string;
    }[];
    expect(saved).toHaveLength(1);
    expect(saved[0]?.baseUrl).toBe(second.baseUrl);
    expect(saved[0]?.placement).toBe("embed");
    first.stop();
    second.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a remembered dead address does not block the live one", async () => {
    const oc = fakeOpencode();
    const dir = mkdtempSync(join(tmpdir(), "strata-boot-"));
    writeFileSync(
      join(dir, "connections.json"),
      JSON.stringify([{ baseUrl: "http://127.0.0.1:1" }, { baseUrl: oc.baseUrl }]) + "\n",
    );
    const svc = startService({ db: join(dir, "events.db"), port: 0, autoConnectTimeoutMs: 2_000 });
    const base = `http://127.0.0.1:${svc.port}`;
    const started = Date.now();
    let conns = 0;
    while (Date.now() - started < 2_000) {
      const health = (await fetch(`${base}/health`).then((r) => r.json())) as { conns: number };
      conns = health.conns;
      if (conns >= 1) break;
      await Bun.sleep(50);
    }
    expect(conns).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_500);
    svc.stop();
    oc.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("live stream broadcasts new events", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;

    const streamed = new Promise<unknown[]>((resolve) => {
      const got: unknown[] = [];
      void fetch(`${base}/stream`).then(async (res) => {
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (got.length < 2) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop()!;
          for (const p of parts) {
            const line = p.replace(/^data: /, "").trim();
            if (line) got.push(JSON.parse(line));
          }
        }
        void reader.cancel();
        resolve(got);
      });
    });

    await new Promise((r) => setTimeout(r, 30));
    seed(svc, "opencode:s3");

    const live = (await streamed) as { type: string }[];
    expect(live[0]!.type).toBe("service.connected");
    expect(live[1]!.type).toBe("session.started");

    svc.stop();
  });

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
    const dirs = workspaces.workspaces.map((w: { directory: string }) => w.directory).sort();
    expect(dirs).toEqual(["/tmp/box", "/tmp/x"]);

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
      ev(
        sid,
        "turn.assistant",
        {
          turn_id: "t1",
          content: [{ type: "text", text: "the anchor is a scrollTop reader" }],
          stop_reason: "end_turn",
        },
        "2026-01-01T00:00:01Z",
      ),
      ev(
        sid,
        "tool.call",
        { turn_id: "t2", call_id: "c1", tool: "bash", input: { command: "echo scrollTop" } },
        "2026-01-01T00:00:02Z",
      ),
      ev(
        sid,
        "tool.result",
        { call_id: "c1", status: "ok", output: "printed scrollTop to stdout" },
        "2026-01-01T00:00:03Z",
      ),
      // Same word, different session: the search must not leak across sessions.
      ev(
        "opencode:other",
        "session.started",
        { title: "other", workspace: "/tmp/x" },
        "2026-01-02T00:00:00Z",
      ),
      ev(
        "opencode:other",
        "turn.user",
        { turn_id: "t9", content: [{ type: "text", text: "scrollTop lives here too" }] },
        "2026-01-02T00:00:01Z",
      ),
    ]);

    const res = await fetch(
      `${base}/sessions/${encodeURIComponent(sid)}/search?q=scrollTop`,
    ).then((r) => r.json());
    expect(res.more).toBe(false);
    expect(res.hits.length).toBe(3);

    // A tool result names its call, not its turn — the projector binds the two.
    // Without the call id reaching the reader those hits are rows that look
    // jumpable and silently do nothing, which is most of what a search returns.
    const byType = Object.fromEntries(res.hits.map((h: { type: string }) => [h.type, h]));
    expect(byType["turn.assistant"].turn_id).toBe("t1");
    expect(byType["tool.call"].turn_id).toBe("t2");
    expect(byType["tool.result"].turn_id).toBeNull();
    expect(byType["tool.result"].call_id).toBe("c1");
    // Every hit must carry something the transcript can resolve.
    expect(res.hits.every((h: { turn_id: string | null; call_id: string | null }) => h.turn_id || h.call_id)).toBe(true);
    // FTS brackets its matches; the reader's snippet splits on those.
    expect(byType["tool.result"].snippet).toContain("[scrollTop]");

    // Truncation is reported rather than passed off as the whole list.
    const capped = await fetch(
      `${base}/sessions/${encodeURIComponent(sid)}/search?q=scrollTop&limit=2`,
    ).then((r) => r.json());
    expect(capped.hits.length).toBe(2);
    expect(capped.more).toBe(true);

    const empty = await fetch(
      `${base}/sessions/${encodeURIComponent(sid)}/search?q=nothingmatchesthis`,
    ).then((r) => r.json());
    expect(empty.hits).toEqual([]);

    svc.stop();
  });

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
        properties: {
          id: "perm1", sessionID: "ses_wait", permission: "bash",
          patterns: ["ls"], metadata: {}, always: ["ls"],
        },
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
    // The reply is recorded before the service resolves the local card.
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
        properties: {
          id: "perm-done", sessionID: "ses_done", permission: "bash",
          patterns: ["ls"], metadata: {}, always: [],
        },
      },
    });
    let pending = false;
    for (let i = 0; i < 20 && !pending; i++) {
      await Bun.sleep(50);
      const body = (await fetch(`${base}/permissions`).then((r) => r.json())) as {
        pending: { request_id: string }[];
      };
      pending = body.pending.some((p) => p.request_id === "perm-done");
    }
    expect(pending).toBe(true);
    oc.push({
      directory: "/repo",
      payload: {
        type: "permission.replied",
        properties: { sessionID: "ses_done", requestID: "perm-done", reply: "once" },
      },
    });
    let cleared = false;
    for (let i = 0; i < 20 && !cleared; i++) {
      await Bun.sleep(50);
      const body = (await fetch(`${base}/permissions`).then((r) => r.json())) as {
        pending: { request_id: string }[];
      };
      cleared = !body.pending.some((p) => p.request_id === "perm-done");
    }
    expect(cleared).toBe(true);
    oc.stop();
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
      "/session/ses_x/revert": () =>
        Response.json({ id: "ses_x", directory: "/repo", title: "x", time: { created: 1, updated: 1 } }),
      "/session/ses_x/unrevert": () =>
        Response.json({ id: "ses_x", directory: "/repo", title: "x", time: { created: 1, updated: 1 } }),
      "/session/ses_x/fork": () =>
        Response.json({ id: "ses_fork", directory: "/repo", title: "fork", time: { created: 1, updated: 1 } }),
      "/session/ses_fork": () =>
        Response.json({ id: "ses_fork", directory: "/repo", title: "x (fork #3)", time: { created: 1, updated: 1 } }),
      "/session/ses_x/summarize": () => Response.json(true),
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (p: string, body?: unknown) =>
      fetch(`${base}${p}`, {
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
      connected: true,
      revert: true,
      fork: true,
      summarize: true,
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

    const modeled = await post(`/sessions/${sid}/summarize`, {
      model: { providerID: "openai", modelID: "gpt-5" },
    });
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
    svc.store.append([
      ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z"),
    ]);
    const sid = encodeURIComponent("opencode:ses_x");
    const summarize = await fetch(`${base}/sessions/${sid}/summarize`, { method: "POST" });
    expect(summarize.status).toBe(502);
    expect(JSON.stringify(await summarize.json())).toContain("model refused");
    oc.stop();
    svc.stop();
  });

  test("a current OpenCode stages a revert, and a refusal is not a silent ok", async () => {
    const oc = fakeOpencode({
      "/api/session/ses_x/revert/stage": () => Response.json({ data: { messageID: "msg_1" } }),
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });
    svc.store.append([
      ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z"),
    ]);
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
    svc2.store.append([
      ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z"),
    ]);
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
    svc3.store.append([
      ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z"),
    ]);
    const undo = await fetch(`${base3}/sessions/${sid}/unrevert`, { method: "POST" });
    expect(undo.status).toBe(200);
    expect(restored.seen.some((s) => s.path === "/api/session/ses_x/revert" && s.method === "DELETE")).toBe(true);
    expect(restored.seen.some((s) => s.path === "/session/ses_x/unrevert")).toBe(false);
    restored.stop();
    svc3.stop();
  });

  test("an OpenCode session can connect and disconnect an MCP server", async () => {
    const oc = fakeOpencode({
      "/mcp/srv/connect": () => Response.json({ status: "connected" }),
      "/mcp/srv/disconnect": () => Response.json({ status: "connected" }),
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (p: string, body?: unknown) =>
      fetch(`${base}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    await post("/connect", { baseUrl: oc.baseUrl, directory: "/repo" });
    svc.store.append([
      ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z"),
    ]);
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
    const oc = fakeOpencode({
      "/mcp": () => Response.json({ leaked: "https://mcp.example/secret-token" }),
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (p: string, body?: unknown) =>
      fetch(`${base}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    await post("/connect", { baseUrl: oc.baseUrl, directory: "/repo" });
    svc.store.append([
      ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z"),
    ]);
    const sid = encodeURIComponent("opencode:ses_x");

    const added = await post(`/sessions/${sid}/mcp`, { name: "docs", url: "https://mcp.example/rpc" });
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ ok: true });
    const seen = oc.seen.find((s) => s.method === "POST" && s.path === "/mcp");
    expect(JSON.parse(seen!.body)).toEqual({
      name: "docs",
      config: { type: "remote", url: "https://mcp.example/rpc" },
    });
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
    const oc = fakeOpencode({
      "/mcp": () => Response.json({ message: `refused ${url}` }, { status: 400 }),
    });
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    await fetch(`${base}/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: oc.baseUrl, directory: "/repo" }),
    });
    svc.store.append([
      ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z"),
    ]);
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
    const post = (p: string, body?: unknown) =>
      fetch(`${base}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    await post("/connect", { baseUrl: oc.baseUrl, directory: "/repo" });
    svc.store.append([
      ev("opencode:ses_x", "session.started", { title: "x", workspace: "/repo" }, "2026-01-01T00:00:00Z"),
    ]);
    const sid = encodeURIComponent("opencode:ses_x");

    const started = await post(`/sessions/${sid}/mcp/docs/auth`);
    expect(started.status).toBe(200);
    const startedText = await started.text();
    expect(startedText).not.toContain(state);
    expect(JSON.parse(startedText)).toEqual({ url: "https://idp.example/authorize" });
    expect(oc.seen.find((s) => s.path === "/mcp/docs/auth")?.query.get("directory")).toBe("/repo");

    const missing = await post(`/sessions/${sid}/mcp/docs/auth/callback`, {});
    expect(missing.status).toBe(400);

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

describe("only the desktop shell reaches the service from a browser", () => {
  let svc: ReturnType<typeof startService>;
  let base = "";
  beforeAll(() => {
    svc = startService({ db: ":memory:", port: 0 });
    base = `http://127.0.0.1:${svc.port}`;
  });
  afterAll(() => svc.stop());
  test("a page on another site cannot make strata run a command", async () => {
    const res = await fetch(`${base}/connect`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "text/plain" },
      body: JSON.stringify({ backend: "acp", command: "strata-test-should-never-run" }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("a page on another port of this machine is another site too", async () => {
    expect((await fetch(`${base}/sessions`, { headers: { "sec-fetch-site": "same-site" } })).status).toBe(403);
    expect((await fetch(`${base}/sessions`, { headers: { origin: "http://localhost:3000" } })).status).toBe(403);
    expect((await fetch(`${base}/sessions`, { headers: { origin: "http://127.0.0.1:3000" } })).status).toBe(403);
  });

  test("a route that throws still answers the shell in JSON it can read", async () => {
    const res = await fetch(`${base}/sessions/%E0%A4%A/view`, { headers: { origin: "http://tauri.localhost" } });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
    expect(typeof ((await res.json()) as { error: string }).error).toBe("string");
  });

  test("a request another site made the browser send, or a rebound Host, goes nowhere", async () => {
    expect((await fetch(`${base}/sync`, { method: "POST", headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await fetch(`${base}/sessions`, { headers: { origin: "null" } })).status).toBe(403);
    expect((await fetch(`${base}/stream`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/health`, { headers: { host: "evil.example" } })).status).toBe(403);
  });

  test("a preflight is granted to the shell and nobody else", async () => {
    const ask = (origin: string) =>
      fetch(`${base}/connect`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
      });
    const shell = await ask("http://tauri.localhost");
    expect(shell.status).toBe(204);
    expect(shell.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
    expect(shell.headers.get("access-control-allow-methods")).toContain("POST");
    expect(shell.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(shell.headers.get("access-control-allow-headers")).toContain("content-type");
    expect((await ask("https://evil.example")).status).toBe(403);
  });

  test("the shell reads every route cross-origin, the dev proxy reads it same-origin", async () => {
    for (const origin of ["http://tauri.localhost", "tauri://localhost", "http://localhost:5178"]) {
      const res = await fetch(`${base}/health`, { headers: { origin, "sec-fetch-site": "cross-site" } });
      expect(res.status).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe(origin);
      expect(res.headers.get("vary")).toContain("origin");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const proxied = await fetch(`${base}/sync`, {
      method: "POST",
      headers: { host: "localhost:5178", origin: "http://localhost:5178", "sec-fetch-site": "same-origin" },
    });
    expect(proxied.status).toBe(200);
    const stream = await fetch(`${base}/stream`, { headers: { origin: "http://tauri.localhost" } });
    expect(stream.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
    await stream.body?.cancel();
  });
});

describe("the service exposes the opencode launch mode and status", () => {
  const withDesktopDir = (run: (desktopDir: string, base: string) => Promise<void>) => {
    const desktopDir = mkdtempSync(join(tmpdir(), "agent-strata-desktop-"));
    const svc = startService({ db: ":memory:", port: 0, desktopDir });
    return run(desktopDir, `http://127.0.0.1:${svc.port}`).finally(() => {
      svc.stop();
      rmSync(desktopDir, { recursive: true, force: true });
    });
  };

  test("GET /desktop/opencode is unmanaged embed when no files exist", async () => {
    await withDesktopDir(async (_desktopDir, base) => {
      const res = await fetch(`${base}/desktop/opencode`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ mode: "embed", state: "unmanaged" });
    });
  });

  test("GET /desktop/opencode returns the status file and omits a password", async () => {
    await withDesktopDir(async (desktopDir, base) => {
      writeFileSync(
        join(desktopDir, "opencode-status.json"),
        JSON.stringify({ mode: "embed", state: "missing", password: "secret" }),
      );
      const got = (await fetch(`${base}/desktop/opencode`).then((r) => r.json())) as Record<string, unknown>;
      expect(got).toEqual({ mode: "embed", state: "missing" });
      expect(got).not.toHaveProperty("password");
    });
  });

  test("GET /desktop/opencode prefers the saved mode over the running status", async () => {
    await withDesktopDir(async (desktopDir, base) => {
      writeFileSync(join(desktopDir, "desktop.json"), JSON.stringify({ opencode: "external" }));
      writeFileSync(
        join(desktopDir, "opencode-status.json"),
        JSON.stringify({ mode: "embed", state: "running", url: "http://127.0.0.1:9" }),
      );
      const got = await fetch(`${base}/desktop/opencode`).then((r) => r.json());
      expect(got).toEqual({
        mode: "external",
        state: "running",
        url: "http://127.0.0.1:9",
      });
    });
  });

  test("GET /desktop/opencode includes the binary the shell inspected", async () => {
    await withDesktopDir(async (desktopDir, base) => {
      writeFileSync(
        join(desktopDir, "opencode-runtime.json"),
        JSON.stringify({
          source: "setting",
          bin: "/opt/opencode",
          version: "1.18.30",
          checked_at: 1_700_000_000,
        }),
      );
      const got = await fetch(`${base}/desktop/opencode`).then((r) => r.json());
      expect(got).toEqual({
        mode: "embed",
        state: "unmanaged",
        runtime: {
          source: "setting",
          bin: "/opt/opencode",
          version: "1.18.30",
          checked_at: 1_700_000_000,
        },
      });
    });
  });

  test("PUT /desktop/opencode saves the mode for the next launch", async () => {
    await withDesktopDir(async (desktopDir, base) => {
      writeFileSync(
        join(desktopDir, "desktop.json"),
        JSON.stringify({ opencode: "embed", opencodeBin: "/opt/opencode" }),
      );
      const res = await fetch(`${base}/desktop/opencode`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "external" }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ mode: "external", applied: "next-launch" });
      // The mode changes; the binary chosen for the next launch does not.
      expect(JSON.parse(readFileSync(join(desktopDir, "desktop.json"), "utf8"))).toEqual({
        opencode: "external",
        opencodeBin: "/opt/opencode",
      });

      const bad = await fetch(`${base}/desktop/opencode`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(bad.status).toBe(400);
    });
  });
});

/**
 * A question the log still holds, with no live promise behind it.
 *
 * This is the shape of every launch: `pendingQuestions` is a map of promises
 * handed back to whoever was connected when the question arrived, so a
 * restart empties it, and `/questions` used to answer from that map alone. The
 * window was not hypothetical — the connection only re-reads the backend's
 * pending prompts on a 30s clock, so for the first half-minute after every
 * start an unanswered question rendered as no card and no marker on the
 * session that was waiting. Reading the projection closes it: the event log
 * remembers, and nothing in this test ever goes near a live connection.
 */
describe("a question outlives the process that received it", () => {
  const seedQuestion = (svc: ReturnType<typeof startService>, sessionId: string, requestId: string) =>
    svc.store.append([
      ev(
        sessionId,
        "question.asked",
        {
          request_id: requestId,
          questions: [
            {
              question: "Which approach?",
              header: "Approach",
              options: [{ label: "A", description: "split" }, { label: "B", description: "keep" }],
            },
          ],
        },
        "2026-01-01T00:00:05Z",
      ),
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
    const row = sessions.sessions.find((s: { summary: { session_id: string } }) =>
      s.summary.session_id === "opencode:s1",
    );
    expect(row.needs_input).toBe(true);

    svc.stop();
  });

  test("answering it succeeds and retires the card", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    seedQuestion(svc, "opencode:s1", "que_restart");

    // Before: answering a question the process never saw was a dead end — a
    // 404 from a lookup into a map that restart had already emptied, which the
    // UI could only surface as "no pending question".
    const res = await fetch(`${base}/questions/que_restart/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reply", answers: [["A"]] }),
    });
    expect(res.status).toBe(200);

    const { pending } = await fetch(`${base}/questions`).then((r) => r.json());
    expect(pending).toEqual([]);

    const sessions = await fetch(`${base}/sessions`).then((r) => r.json());
    const row = sessions.sessions.find((s: { summary: { session_id: string } }) =>
      s.summary.session_id === "opencode:s1",
    );
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

describe("handoff", () => {
  test("a handoff opens a new session on another backend and leaves the source", async () => {
    const MOCK = fileURLToPath(new URL("../../adapter-acp/test/fixtures/mock-agent.ts", import.meta.url));
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    const post = (p: string, body?: unknown) =>
      fetch(`${base}${p}`, {
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
      backend: "acp",
      command: process.execPath,
      args: [MOCK],
      agentName: "mock",
      cwd: tmpdir(),
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
    expect(same.status).toBe(400);
    expect(((await same.json()) as { error: string }).error).toMatch(/already runs/);

    svc.stop();
  });
});


describe("store maintenance", () => {
  const withFileStore = async (
    run: (ctx: {
      dir: string;
      db: string;
      base: string;
      svc: ReturnType<typeof startService>;
    }) => Promise<void>,
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "strata-maintenance-"));
    const db = join(dir, "events.db");
    const desktopDir = join(dir, "profile");
    const svc = startService({ db, port: 0, desktopDir });
    const base = `http://127.0.0.1:${svc.port}`;
    try {
      await run({ dir, db, base, svc });
    } finally {
      svc.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  };

  const fact = (sessionId: string) =>
    ev(
      sessionId,
      "permission.requested",
      { request_id: "p1", tool: "bash", input: { command: "ls" } },
      "2026-01-01T00:00:03Z",
    );

  test("a session page reports whether more rows were left behind", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    for (const id of ["a", "b", "c"]) {
      svc.store.append([
        ev(
          `opencode:${id}`,
          "session.started",
          { title: id, workspace: `/tmp/${id}` },
          `2026-01-0${id === "a" ? 1 : id === "b" ? 2 : 3}T00:00:00Z`,
        ),
      ]);
    }
    const first = await fetch(`${base}/sessions?limit=2`).then((r) => r.json());
    expect(first.sessions).toHaveLength(2);
    expect(first.more).toBe(true);
    const all = await fetch(`${base}/sessions?limit=5`).then((r) => r.json());
    expect(all.sessions).toHaveLength(3);
    expect(all.more).toBe(false);
    svc.stop();
  });

  test("the snapshot reports file sizes and the rebuildable/local split", async () => {
    await withFileStore(async ({ db, base, svc }) => {
      svc.store.append([
        ev("opencode:a", "session.started", { title: "A", workspace: "/a" }, "2026-01-01T00:00:00Z"),
        ev(
          "opencode:a",
          "turn.user",
          { turn_id: "t1", content: [{ type: "text", text: "hello" }] },
          "2026-01-01T00:00:01Z",
        ),
        fact("opencode:a"),
      ]);
      const got = (await fetch(`${base}/maintenance`).then((r) => r.json())) as {
        db: { path: string; bytes: number; stats: Record<string, unknown> };
        backups: unknown[];
        legacy: unknown[];
      };
      expect(got.db.path).toBe(db);
      expect(got.db.bytes).toBeGreaterThan(0);
      expect(got.db.stats).toMatchObject({
        sessions: 1,
        events: 3,
        rebuildable: { events: 2 },
        local: { events: 1 },
      });
      expect(got.backups).toEqual([]);
      expect(got.legacy).toEqual([]);
    });
  });

  test("a clean previews, then removes only rebuildable events", async () => {
    await withFileStore(async ({ base, svc }) => {
      svc.store.append([
        ev("opencode:a", "session.started", { title: "A", workspace: "/a" }, "2026-01-01T00:00:00Z"),
        ev(
          "opencode:a",
          "turn.user",
          { turn_id: "t1", content: [{ type: "text", text: "hello" }] },
          "2026-01-01T00:00:01Z",
        ),
        fact("opencode:a"),
      ]);
      const post = (body: unknown) =>
        fetch(`${base}/maintenance/clean`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }).then((r) => r.json());

      const preview = await post({ mode: "rebuildable", session_ids: ["opencode:a"] });
      expect(preview.applied).toBe(false);
      expect(preview.totals).toMatchObject({ sessions: 1, rebuildable: 2, local: 1 });
      expect(preview.targets[0]).toMatchObject({ title: "A", rebuildable: 2, local: 1 });

      const applied = await post({
        mode: "rebuildable",
        session_ids: ["opencode:a"],
        apply: true,
      });
      expect(applied.deleted).toBe(2);
      expect(svc.store.read({ session_id: "opencode:a" }).map((e) => e.type)).toEqual([
        "permission.requested",
      ]);
      expect(svc.store.listSessions()).toHaveLength(1);
    });
  });

  test("a backup is listed and can be deleted", async () => {
    await withFileStore(async ({ base, dir, svc }) => {
      svc.store.append([
        ev("opencode:a", "session.started", { title: "A", workspace: "/a" }, "2026-01-01T00:00:00Z"),
      ]);
      const after = (await fetch(`${base}/maintenance/backup`, { method: "POST" }).then((r) =>
        r.json(),
      )) as { backups: { name: string; bytes: number }[] };
      expect(after.backups).toHaveLength(1);
      const name = after.backups[0]!.name;
      expect(after.backups[0]!.bytes).toBeGreaterThan(0);
      expect(existsSync(join(dir, "backups", name))).toBe(true);

      const removed = (await fetch(`${base}/maintenance/backups/${encodeURIComponent(name)}`, {
        method: "DELETE",
      }).then((r) => r.json())) as { backups: unknown[] };
      expect(removed.backups).toEqual([]);
      expect(existsSync(join(dir, "backups", name))).toBe(false);
    });
  });

  test("session data names the two classes, and local delete needs no backend", async () => {
    await withFileStore(async ({ base, svc }) => {
      svc.store.append([
        ev("opencode:a", "session.started", { title: "A", workspace: "/a" }, "2026-01-01T00:00:00Z"),
        ev(
          "opencode:a",
          "turn.user",
          { turn_id: "t1", content: [{ type: "text", text: "hello" }] },
          "2026-01-01T00:00:01Z",
        ),
        fact("opencode:a"),
      ]);
      const data = await fetch(`${base}/sessions/${encodeURIComponent("opencode:a")}/data`).then(
        (r) => r.json(),
      );
      expect(data).toMatchObject({
        session_id: "opencode:a",
        rebuildable: 2,
        local: 1,
        backend: false,
        can_delete: false,
      });

      const refused = await fetch(`${base}/sessions/${encodeURIComponent("opencode:a")}`, {
        method: "DELETE",
      });
      expect(refused.status).toBe(409);
      const body = await refused.json();
      expect(body).toMatchObject({ local_only: true, local: 1 });

      const removed = await fetch(
        `${base}/sessions/${encodeURIComponent("opencode:a")}?local=1`,
        { method: "DELETE" },
      );
      expect(removed.status).toBe(200);
      expect(await removed.json()).toMatchObject({ ok: true, backend: false, local: 1 });
      expect(svc.store.read({ session_id: "opencode:a" })).toHaveLength(0);
    });
  });

  test("legacy snapshots are visible and deletable; other names are not", async () => {
    await withFileStore(async ({ base, dir }) => {
      writeFileSync(join(dir, "events.db.bak-20260101-0000"), "old");
      const listed = (await fetch(`${base}/maintenance`).then((r) => r.json())) as {
        legacy: { name: string; bytes: number }[];
      };
      expect(listed.legacy.map((file) => file.name)).toContain("events.db.bak-20260101-0000");

      const bad = await fetch(`${base}/maintenance/legacy/events.db`, { method: "DELETE" });
      expect(bad.status).toBe(400);

      const removed = await fetch(
        `${base}/maintenance/legacy/${encodeURIComponent("events.db.bak-20260101-0000")}`,
        { method: "DELETE" },
      );
      expect(removed.status).toBe(200);
      expect(existsSync(join(dir, "events.db.bak-20260101-0000"))).toBe(false);
    });
  });
});
