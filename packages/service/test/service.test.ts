import { describe, expect, test } from "bun:test";
import { startService } from "../src/index";
import { makeEvent, type EventInput, type Event } from "@agent-strata/schema";

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
  test("health, sessions, events, view, compare, export", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;

    const healthRes = await fetch(`${base}/health`);
    expect(healthRes.headers.get("access-control-allow-origin")).toBe("*");
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
});
