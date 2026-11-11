import { makeEvent, type EventInput } from "@agent-strata/schema";
import { startService, type RunningService, type ServiceOpts } from "../src/index";

export const ev = (
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

export const seed = (svc: RunningService, sessionId = "opencode:s1") => {
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

export function serviceHarness(opts: ServiceOpts = {}) {
  const svc = startService({ db: ":memory:", port: 0, ...opts });
  const base = `http://127.0.0.1:${svc.port}`;
  const post = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const put = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { svc, base, post, put, stop: () => svc.stop() };
}
