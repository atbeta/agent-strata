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

    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.ok).toBe(true);

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
});
