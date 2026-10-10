import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
      backend: "acp", command: process.execPath, args: [MOCK], agentName: "mock", cwd: "/tmp",
    }).then((r) => r.json());
    expect(connected.id).toStartWith("acp:mock:");
    const conns = await fetch(`${base}/connections`).then((r) => r.json());
    expect(conns.connections[0]).toMatchObject({ backend: "acp", capabilities: { prompt: true, models: false } });

    const created = await post("/sessions", { connection_id: connected.id, directory: "/tmp" }).then((r) => r.json());
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
      backend: "acp", command: process.execPath, args: [MOCK], agentName: "opencode", cwd: "/tmp",
    }).then((r) => r.json());
    const created = await post("/sessions", { connection_id: connected.id, directory: "/tmp" }).then((r) => r.json());
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
    expect(sync).toEqual({ connected: false, imported: 0 });

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
    // The 200 is sent before the adapter's reply fetch is recorded on the fake.
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

    expect((await post(`/sessions/${sid}/fork`, {})).status).toBe(400);
    const fork = await post(`/sessions/${sid}/fork`, { message_id: "msg_1" });
    expect(fork.status).toBe(200);
    expect(await fork.json()).toEqual({ id: "opencode:ses_fork" });
    const forkSeen = oc.seen.filter((s) => s.path === "/session/ses_x/fork").at(-1);
    expect(JSON.parse(forkSeen!.body)).toEqual({ messageID: "msg_1" });

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
    expect(shell.headers.get("access-control-allow-headers")).toBe("content-type");
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
