import { describe, expect, test } from "bun:test";
import { aggregate, projectSession } from "../src/index";
import { makeEvent, parseEvent, type Event, type EventInput } from "@agent-strata/schema";

let seq = 0;
const mk = (session_id: string, type: string, data: object): Event => {
  const input = makeEvent({
    session_id,
    ts: new Date().toISOString(),
    source: { backend: "b1" },
    type,
    data,
  } as EventInput);
  return parseEvent({ ...input, seq: ++seq });
};

const assistantUsage = { input: 10, output: 5, reasoning: 2, cache_read: 1, cache_write: 3 };

describe("projector", () => {
  test("simple turn", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w", title: "T" }),
      mk("s", "turn.user", { turn_id: "t1", content: [{ type: "text", text: "hi" }] }),
      mk("s", "turn.assistant", {
        turn_id: "t1",
        content: [{ type: "text", text: "yo" }],
        model: "m1",
        usage: assistantUsage,
        cost_usd: 0.5,
      }),
      mk("s", "session.ended", { reason: "completed" }),
    ]);
    expect(v.status).toBe("completed");
    expect(v.workspace).toBe("/w");
    expect(v.turns.length).toBe(1);
    expect(v.turns[0]!.user![0]).toEqual({ type: "text", text: "hi" });
    expect(v.turns[0]!.assistant[0]!.model).toBe("m1");
    expect(v.totals).toMatchObject({
      input: 10, output: 5, reasoning: 2, cache_read: 1, cache_write: 3, cost_usd: 0.5,
    });
  });

  test("multi tool calls with results", () => {
    const v = projectSession([
      mk("s", "tool.call", { turn_id: "t", call_id: "c1", tool: "bash", input: { command: "ls" } }),
      mk("s", "tool.call", { turn_id: "t", call_id: "c2", tool: "read", input: {} }),
      mk("s", "tool.result", { call_id: "c1", status: "ok", output: "files" }),
      mk("s", "tool.result", { call_id: "c2", status: "error", output: "nope" }),
    ]);
    const calls = v.turns[0]!.tool_calls;
    expect(calls.length).toBe(2);
    expect(calls[0]!.status).toBe("ok");
    expect(calls[0]!.output).toBe("files");
    expect(calls[1]!.status).toBe("error");
    expect(v.totals.tool_calls).toBe(2);
    expect(v.totals.tool_errors).toBe(1);
    expect(v.orphans.length).toBe(0);
  });

  test("orphan tool.result", () => {
    const v = projectSession([
      mk("s", "tool.result", { call_id: "ghost", status: "ok", output: "?" }),
    ]);
    expect(v.orphans.length).toBe(1);
    expect(v.orphans[0]!.call_id).toBe("ghost");
  });

  test("permission deny path counts permissions_denied and links to call", () => {
    const v = projectSession([
      mk("s", "tool.call", { turn_id: "t", call_id: "c1", tool: "bash", input: {} }),
      mk("s", "permission.requested", { request_id: "r1", call_id: "c1", tool: "bash", input: {} }),
      mk("s", "permission.requested", { request_id: "r2", tool: "write", input: {} }),
      mk("s", "permission.resolved", { request_id: "r1", decision: "deny", by: "user" }),
    ]);
    const call = v.turns[0]!.tool_calls[0]!;
    expect(call.permission!.decision).toBe("deny");
    expect(call.permission!.by).toBe("user");
    expect(v.pending_permissions.length).toBe(1);
    expect(v.pending_permissions[0]!.request_id).toBe("r2");
    expect(v.totals.permissions_denied).toBe(1);
  });

  test("permission.requested before its tool.call still attaches", () => {
    const v = projectSession([
      mk("s", "permission.requested", { request_id: "r1", call_id: "c1", tool: "bash", input: {} }),
      mk("s", "tool.call", { turn_id: "t", call_id: "c1", tool: "bash", input: {} }),
      mk("s", "permission.resolved", { request_id: "r1", decision: "allow", by: "policy", rule_id: "allow-echo" }),
      mk("s", "tool.result", { call_id: "c1", status: "ok", output: "hi" }),
    ]);
    const call = v.turns[0]!.tool_calls[0]!;
    expect(call.permission!.decision).toBe("allow");
    expect(call.permission!.rule_id).toBe("allow-echo");
    expect(v.pending_permissions.length).toBe(0);
  });

  test("out-of-order input sorted by seq", () => {
    const call = mk("s", "tool.call", { turn_id: "t", call_id: "c1", tool: "bash", input: {} });
    const result = mk("s", "tool.result", { call_id: "c1", status: "ok" });
    const evs = [result, call]; // arrival order != seq order
    const v = projectSession(evs);
    expect(v.turns[0]!.tool_calls[0]!.status).toBe("ok");
  });

  test("interrupted vs pending", () => {
    const ended = projectSession([
      mk("s1", "tool.call", { turn_id: "t", call_id: "c1", tool: "bash", input: {} }),
      mk("s1", "session.ended", { reason: "cancelled" }),
    ]);
    expect(ended.turns[0]!.tool_calls[0]!.status).toBe("interrupted");
    const active = projectSession([
      mk("s2", "tool.call", { turn_id: "t", call_id: "c1", tool: "bash", input: {} }),
    ]);
    expect(active.status).toBe("active");
    expect(active.turns[0]!.tool_calls[0]!.status).toBe("pending");
  });

  test("plan and files_changed", () => {
    const v = projectSession([
      mk("s", "plan.updated", { entries: [{ content: "a", status: "pending" }] }),
      mk("s", "plan.updated", { entries: [{ content: "a", status: "completed" }] }),
      mk("s", "file.changed", { path: "x", change: "add" }),
      mk("s", "file.changed", { path: "x", change: "modify" }),
      mk("s", "file.changed", { path: "y", change: "delete" }),
    ]);
    expect(v.plan).toEqual([{ content: "a", status: "completed" }]);
    expect(v.files_changed).toEqual([
      { path: "x", change: "modify", count: 2 },
      { path: "y", change: "delete", count: 1 },
    ]);
  });

  test("aggregate across 2 backends/models", () => {
    const v1 = projectSession([
      mk("s", "turn.assistant", {
        turn_id: "t", content: [], model: "m1",
        usage: { input: 10, output: 5 }, cost_usd: 1,
      }),
    ]);
    const e2 = mk("s2", "turn.assistant", {
      turn_id: "t", content: [],
      usage: { input: 4, output: 2 }, cost_usd: 0.5,
    });
    const v2 = projectSession([{ ...e2, source: { backend: "b2" } } as Event]);
    const agg = aggregate([v1, v2]);
    expect(Object.keys(agg.by_backend).sort()).toEqual(["b1", "b2"]);
    expect(agg.by_backend.b1!.input).toBe(10);
    expect(agg.by_backend.b2!.input).toBe(4);
    expect(agg.by_model["m1"]).toEqual({ input: 10, output: 5, cost_usd: 1, turns: 1 });
    expect(agg.by_model["unknown"]).toEqual({ input: 4, output: 2, cost_usd: 0.5, turns: 1 });
    expect(agg.total.cost_usd).toBe(1.5);
  });

  test("busy flag and pending questions follow the latest events", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "session.status", { state: "busy" }),
      mk("s", "question.asked", {
        request_id: "q1",
        questions: [
          {
            question: "Pick",
            header: "Pick",
            options: [{ label: "a", description: "A" }],
          },
        ],
      }),
    ]);
    expect(v.busy).toBe(true);
    expect(v.pending_questions.map((q) => q.request_id)).toEqual(["q1"]);
    const done = projectSession([
      ...[
        mk("s2", "session.started", { workspace: "/w" }),
        mk("s2", "session.status", { state: "busy" }),
        mk("s2", "question.asked", {
          request_id: "q1",
          questions: [{ question: "Pick", header: "Pick", options: [{ label: "a", description: "A" }] }],
        }),
        mk("s2", "question.resolved", { request_id: "q1", decision: "reply", answers: [["a"]] }),
        mk("s2", "session.status", { state: "idle" }),
      ],
    ]);
    expect(done.busy).toBe(false);
    expect(done.pending_questions).toEqual([]);
  });

  test("mixed session ids throw", () => {
    expect(() =>
      projectSession([
        mk("s1", "session.started", { workspace: "/a" }),
        mk("s2", "session.started", { workspace: "/b" }),
      ]),
    ).toThrow();
  });
});
