import { describe, expect, test } from "bun:test";
import { startService } from "../src/index";
import { makeEvent, type EventInput } from "@agent-strata/schema";

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

const assistant = (
  sessionId: string,
  ts: string,
  usage: Record<string, number>,
  msgId = `m-${ts}`,
  extra: Record<string, unknown> = {},
) =>
  ev(
    sessionId,
    "turn.assistant",
    {
      turn_id: `t-${ts}`,
      msg_id: msgId,
      content: [{ type: "text", text: "hi" }],
      usage,
      ...extra,
    },
    ts,
  );

interface DailyRow {
  session_id: string;
  day: string;
  model: string | null;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  messages: number;
  tool_calls: number;
  tool_errors: number;
}

const seed = (svc: ReturnType<typeof startService>, sessionId: string) => {
  svc.store.append([
    ev(sessionId, "session.started", { title: "seed", workspace: "/tmp/x" }, "2026-01-01T00:00:00Z"),
  ]);
};

describe("GET /usage/daily", () => {
  test("buckets usage by the caller's local day", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const sid = "opencode:s1";
    seed(svc, sid);
    svc.store.append([
      // 15:30Z is still the 1st in Shanghai (23:30); 16:30Z rolls into the 2nd.
      assistant(sid, "2026-01-01T15:30:00Z", { input: 100, output: 10 }, "m1"),
      assistant(sid, "2026-01-01T16:30:00Z", { input: 200, output: 20 }, "m2"),
    ]);
    const base = `http://127.0.0.1:${svc.port}`;
    const sh = await fetch(`${base}/usage/daily?tz=Asia/Shanghai`).then((r) => r.json());
    expect(sh.rows.map((r: DailyRow) => r.day)).toEqual(["2026-01-01", "2026-01-02"]);
    expect(sh.rows[0]).toMatchObject({ session_id: sid, input: 100, output: 10, messages: 1 });
    expect(sh.rows[1]).toMatchObject({ input: 200, output: 20 });
    const utc = await fetch(`${base}/usage/daily?tz=UTC`).then((r) => r.json());
    expect(utc.rows.map((r: DailyRow) => r.day)).toEqual(["2026-01-01"]);
    expect(utc.rows[0]).toMatchObject({ input: 300, output: 30, messages: 2 });
    svc.stop();
  });

  test("a streamed partial and its final snapshot count once", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const sid = "opencode:s2";
    seed(svc, sid);
    svc.store.append([
      assistant(sid, "2026-01-01T10:00:00Z", { input: 0, output: 0 }, "m1", { partial: true }),
      assistant(sid, "2026-01-01T10:00:01Z", { input: 50, output: 5 }, "m1"),
    ]);
    const base = `http://127.0.0.1:${svc.port}`;
    const { rows } = await fetch(`${base}/usage/daily?tz=UTC`).then((r) => r.json());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ input: 50, output: 5, messages: 1 });
    svc.stop();
  });

  test("buckets sum back to the session's own totals", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const sid = "opencode:s3";
    seed(svc, sid);
    svc.store.append([
      assistant(sid, "2026-01-01T10:00:00Z", { input: 10, output: 5, reasoning: 2, cache_read: 3, cache_write: 1 }, "m1", { cost_usd: 0.1 }),
      ev(sid, "tool.call", { turn_id: "t-2026-01-01T10:00:00Z", call_id: "c1", tool: "bash", input: {} }, "2026-01-01T10:01:00Z"),
      ev(sid, "tool.result", { call_id: "c1", status: "error" }, "2026-01-01T10:02:00Z"),
      assistant(sid, "2026-01-02T10:00:00Z", { input: 20, output: 8 }, "m2", { cost_usd: 0.2 }),
      ev(sid, "tool.call", { turn_id: "t-2026-01-02T10:00:00Z", call_id: "c2", tool: "read", input: {} }, "2026-01-02T10:01:00Z"),
      ev(sid, "tool.result", { call_id: "c2", status: "ok" }, "2026-01-02T10:02:00Z"),
    ]);
    const base = `http://127.0.0.1:${svc.port}`;
    const { rows } = await fetch(`${base}/usage/daily?tz=UTC`).then((r) => r.json());
    const view = await fetch(`${base}/sessions/${encodeURIComponent(sid)}/view`).then((r) => r.json());
    const sum = (k: keyof DailyRow) => rows.reduce((s: number, r: DailyRow) => s + (r[k] as number), 0);
    for (const k of ["input", "output", "reasoning", "cache_read", "cache_write", "cost_usd", "tool_calls"] as const) {
      expect(sum(k)).toBeCloseTo(view.totals[k === "tool_calls" ? "tool_calls" : k]);
    }
    expect(sum("tool_errors")).toBe(1);
    svc.stop();
  });

  test("splits a session-day by model and stamps tool calls with their message's model", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const sid = "opencode:s4";
    seed(svc, sid);
    svc.store.append([
      assistant(sid, "2026-01-01T10:00:00Z", { input: 10, output: 5 }, "m1", { model: "a/model-1" }),
      ev(sid, "tool.call", { turn_id: "t-2026-01-01T10:00:00Z", call_id: "c1", tool: "bash", input: {}, msg_id: "m1" }, "2026-01-01T10:01:00Z"),
      assistant(sid, "2026-01-01T11:00:00Z", { input: 20, output: 5 }, "m2", { model: "a/model-2" }),
      // No msg_id — no message to inherit a model from.
      ev(sid, "tool.call", { turn_id: "t-2026-01-01T10:00:00Z", call_id: "c2", tool: "read", input: {} }, "2026-01-01T12:00:00Z"),
    ]);
    const base = `http://127.0.0.1:${svc.port}`;
    const { rows } = await fetch(`${base}/usage/daily?tz=UTC`).then((r) => r.json());
    const dayRows = rows.filter((r: DailyRow) => r.day === "2026-01-01") as DailyRow[];
    const byModel = new Map<string | null, DailyRow>(dayRows.map((r) => [r.model, r]));
    // Two assistant models → two usage rows; tools bucket per their model.
    // Named models sort before the null bucket within a day.
    expect(dayRows.map((r) => r.model)).toEqual(["a/model-1", "a/model-2", null]);
    expect(byModel.get("a/model-1")).toMatchObject({ input: 10, output: 5, messages: 1, tool_calls: 1 });
    expect(byModel.get("a/model-2")).toMatchObject({ input: 20, output: 5, messages: 1, tool_calls: 0 });
    expect(byModel.get(null)).toMatchObject({ input: 0, messages: 0, tool_calls: 1 });
    // Σ over models is the session-day total.
    expect(dayRows.reduce((s: number, r: DailyRow) => s + r.input, 0)).toBe(30);
    expect(dayRows.reduce((s: number, r: DailyRow) => s + r.tool_calls, 0)).toBe(2);
    svc.stop();
  });

  test("a bad or missing tz is a 400", async () => {
    const svc = startService({ db: ":memory:", port: 0 });
    const base = `http://127.0.0.1:${svc.port}`;
    expect((await fetch(`${base}/usage/daily?tz=Mars/Olympus`)).status).toBe(400);
    expect((await fetch(`${base}/usage/daily`)).status).toBe(400);
    svc.stop();
  });
});
