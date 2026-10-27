import { describe, expect, test } from "bun:test";
import { aggregate, projectSession } from "../src/index";
import { makeEvent, parseEvent, type Event, type EventInput } from "@agent-strata/schema";

let seq = 0;
const mk = (session_id: string, type: string, data: object, ts?: string): Event => {
  const input = makeEvent({
    session_id,
    ts: ts ?? new Date().toISOString(),
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
        agent: "build",
        variant: "high",
        stop_reason: "length",
        usage: assistantUsage,
        cost_usd: 0.5,
      }),
      mk("s", "session.ended", { reason: "completed" }),
    ]);
    expect(v.status).toBe("completed");
    expect(v.workspace).toBe("/w");
    expect(v.turns.length).toBe(1);
    expect(v.turns[0]!.user![0]).toEqual({ type: "text", text: "hi" });
    expect(v.turns[0]!.assistant[0]).toMatchObject({
      model: "m1",
      agent: "build",
      variant: "high",
      stop_reason: "length",
    });
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

  test("a tool result names the child session on the call it completes", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "tool.call", { turn_id: "t", call_id: "c1", tool: "task", input: {} }),
      mk("s", "tool.result", {
        call_id: "c1",
        status: "ok",
        child_session_id: "opencode:ses_kid",
      }),
    ]);
    expect(v.turns[0]!.tool_calls[0]!.child_session_id).toBe("opencode:ses_kid");
  });

  test("a child session named on the tool call stays when the result omits it", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "tool.call", {
        turn_id: "t",
        call_id: "c1",
        tool: "task",
        input: {},
        child_session_id: "opencode:ses_kid",
      }),
      mk("s", "tool.result", { call_id: "c1", status: "ok" }),
    ]);
    expect(v.turns[0]!.tool_calls[0]!.child_session_id).toBe("opencode:ses_kid");
  });

  test("a call restated with the child it opened is an update, not a second card", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "tool.call", { turn_id: "t", call_id: "c1", tool: "task", input: {} }),
      mk("s", "tool.call", {
        turn_id: "t",
        call_id: "c1",
        tool: "task",
        input: {},
        child_session_id: "opencode:ses_kid",
      }),
    ]);
    expect(v.turns[0]!.tool_calls.length).toBe(1);
    expect(v.turns[0]!.tool_calls[0]!.child_session_id).toBe("opencode:ses_kid");
    expect(v.totals.tool_calls).toBe(1);
  });

  test("tool calls sort back into declaration order when the backend stamps it", () => {
    // Started out of order (c1 declared first but ran last), which is what a
    // backend running calls concurrently reports.
    const v = projectSession([
      mk("s", "tool.call", { turn_id: "t", call_id: "c2", tool: "read", input: {}, order: 1 }),
      mk("s", "tool.call", { turn_id: "t", call_id: "c3", tool: "grep", input: {}, order: 2 }),
      mk("s", "tool.call", { turn_id: "t", call_id: "c1", tool: "bash", input: {}, order: 0 }),
      mk("s", "tool.result", { call_id: "c1", status: "ok", output: "done" }),
    ]);
    expect(v.turns[0]!.tool_calls.map((c) => c.tool)).toEqual(["bash", "read", "grep"]);
    // results still attach to the right call after the shuffle
    expect(v.turns[0]!.tool_calls[0]!.output).toBe("done");
    expect(v.totals.tool_errors).toBe(0);
  });

  test("tool calls keep event order when no declaration order is reported", () => {
    const v = projectSession([
      mk("s", "tool.call", { turn_id: "t", call_id: "c1", tool: "bash", input: {} }),
      mk("s", "tool.call", { turn_id: "t", call_id: "c2", tool: "read", input: {} }),
      mk("s", "tool.call", { turn_id: "t", call_id: "c3", tool: "grep", input: {} }),
    ]);
    expect(v.turns[0]!.tool_calls.map((c) => c.tool)).toEqual(["bash", "read", "grep"]);
  });

  test("calls without an ordinal sort after the ones that have one", () => {
    const v = projectSession([
      mk("s", "tool.call", { turn_id: "t", call_id: "c2", tool: "read", input: {}, order: 0 }),
      mk("s", "tool.call", { turn_id: "t", call_id: "cX", tool: "legacy", input: {} }),
      mk("s", "tool.call", { turn_id: "t", call_id: "c1", tool: "bash", input: {}, order: 1 }),
    ]);
    expect(v.turns[0]!.tool_calls.map((c) => c.tool)).toEqual(["read", "bash", "legacy"]);
  });

  test("ordinals that restart per assistant message do not interleave the messages", () => {
    // The ordinal counts within one assistant message, and a turn can hold
    // several. Sorting on the number alone put this at 0,0,1,1,2 and wove the
    // messages through each other; the message is the outer key.
    const v = projectSession([
      mk("s", "turn.assistant", { turn_id: "t", msg_id: "m1", content: [] }),
      mk("s", "tool.call", { turn_id: "t", call_id: "a0", tool: "read", input: {}, order: 0, msg_id: "m1" }),
      mk("s", "tool.call", { turn_id: "t", call_id: "a1", tool: "edit", input: {}, order: 1, msg_id: "m1" }),
      mk("s", "turn.assistant", { turn_id: "t", msg_id: "m2", content: [] }),
      mk("s", "tool.call", { turn_id: "t", call_id: "b0", tool: "bash", input: {}, order: 0, msg_id: "m2" }),
    ]);
    expect(v.turns[0]!.tool_calls.map((c) => c.call_id)).toEqual(["a0", "a1", "b0"]);
  });

  test("a call with no message of its own stays at the end of the turn", () => {
    const v = projectSession([
      mk("s", "turn.assistant", { turn_id: "t", msg_id: "m1", content: [] }),
      mk("s", "tool.call", { turn_id: "t", call_id: "b0", tool: "bash", input: {}, order: 0, msg_id: "m2" }),
      mk("s", "tool.call", { turn_id: "t", call_id: "a0", tool: "read", input: {}, order: 0, msg_id: "m1" }),
      mk("s", "tool.call", { turn_id: "t", call_id: "orphan", tool: "legacy", input: {}, order: 0 }),
    ]);
    // m2 is not a message of this turn, and the legacy call names none at all;
    // both are kept, in event order, after the call that does belong
    expect(v.turns[0]!.tool_calls.map((c) => c.call_id)).toEqual(["a0", "b0", "orphan"]);
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
    expect(v.files_changed.map((f) => ({ path: f.path, change: f.change, count: f.count }))).toEqual([
      { path: "x", change: "modify", count: 2 },
      { path: "y", change: "delete", count: 1 },
    ]);
    // Neither change carried a diff, so both files owe the reader an explanation
    expect(v.files_changed.every((f) => f.unexplained)).toBe(true);
    expect(v.files_changed[0]!.edits).toHaveLength(2);
  });

  test("a change no call explains keeps its place and says so", () => {
    const v = projectSession([
      mk("s", "tool.call", {
        turn_id: "t1",
        call_id: "c1",
        tool: "bash",
        input: { command: "sed -i s/a/b/ x.ts" },
      }),
      mk("s", "file.changed", { path: "x.ts", change: "modify" }),
    ]);
    const f = v.files_changed[0]!;
    // opencode saw the file change, so it is reported — but without a diff we
    // would be inventing one
    expect(f.count).toBe(1);
    expect(f.unexplained).toBe(true);
    expect(f.edits[0]!.diff).toBeUndefined();
    expect(f.additions).toBe(0);
  });

  const PATCH = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-const a = 1\n+const a = 2\n";

  test("a change carries its own diff and points back to the turn of its call", () => {
    const v = projectSession([
      mk("s", "turn.user", { turn_id: "t1", content: [] }),
      mk("s", "tool.call", { turn_id: "t1", call_id: "c1", tool: "edit", input: {} }),
      mk("s", "file.changed", { path: "src/x.ts", change: "modify", call_id: "c1", diff: PATCH }),
    ]);
    const f = v.files_changed[0]!;
    expect(f.unexplained).toBe(false);
    expect([f.additions, f.deletions]).toEqual([1, 1]);
    expect(f.edits[0]).toMatchObject({ call_id: "c1", turn_index: 0, diff: PATCH });
  });

  test("a whole-file change says so", () => {
    const v = projectSession([
      mk("s", "file.changed", { path: "new.ts", change: "add", diff: PATCH, whole_file: true, call_id: "c9" }),
    ]);
    expect(v.files_changed[0]!.edits[0]).toMatchObject({ whole_file: true, turn_index: -1 });
  });

  test("two spellings of one Windows path are one file", () => {
    const v = projectSession([
      mk("s", "file.changed", { path: "D:\\Repo\\x.ts", change: "modify", diff: PATCH }),
      mk("s", "file.changed", { path: "d:/repo/x.ts", change: "modify" }),
    ]);
    expect(v.files_changed).toHaveLength(1);
    expect(v.files_changed[0]!.path).toBe("D:\\Repo\\x.ts");
    expect(v.files_changed[0]!.count).toBe(2);
    expect(v.files_changed[0]!.unexplained).toBe(true);
  });

  test("POSIX paths keep their case", () => {
    const v = projectSession([
      mk("s", "file.changed", { path: "/r/A.ts", change: "modify" }),
      mk("s", "file.changed", { path: "/r/a.ts", change: "modify" }),
    ]);
    expect(v.files_changed.map((f) => f.path)).toEqual(["/r/A.ts", "/r/a.ts"]);
  });

  test("a file changed in two turns lists both, in order", () => {
    const v = projectSession([
      mk("s", "tool.call", { turn_id: "t1", call_id: "c1", tool: "edit", input: {} }),
      mk("s", "file.changed", { path: "x.ts", change: "modify", call_id: "c1", diff: PATCH }),
      mk("s", "tool.call", { turn_id: "t2", call_id: "c2", tool: "edit", input: {} }),
      mk("s", "file.changed", { path: "x.ts", change: "modify", call_id: "c2", diff: PATCH }),
    ]);
    const f = v.files_changed[0]!;
    expect(f.count).toBe(2);
    expect([f.additions, f.deletions]).toEqual([2, 2]);
    expect(f.edits.map((e) => e.turn_index)).toEqual([0, 1]);
  });

  test("tool inputs are never read to invent a diff", () => {
    const v = projectSession([
      mk("s", "tool.call", {
        turn_id: "t1", call_id: "c1", tool: "edit",
        input: { filePath: "x.ts", oldString: "a", newString: "b" },
      }),
      mk("s", "file.changed", { path: "x.ts", change: "modify" }),
    ]);
    expect(v.files_changed[0]!.edits[0]!.diff).toBeUndefined();
    expect(v.files_changed[0]!.unexplained).toBe(true);
  });

  test("a later partial does not reopen a finished assistant message", () => {
    const v = projectSession([
      mk("s", "turn.assistant", {
        turn_id: "t",
        msg_id: "m1",
        content: [
          { type: "thinking", text: "done" },
          { type: "text", text: "answer" },
        ],
        model: "m1",
        usage: assistantUsage,
        cost_usd: 0.5,
      }),
      mk("s", "turn.assistant", {
        turn_id: "t",
        msg_id: "m1",
        partial: true,
        content: [{ type: "thinking", text: "done" }],
      }),
    ]);
    const message = v.turns[0]!.assistant[0]!;
    expect(v.turns[0]!.assistant).toHaveLength(1);
    expect(message.partial).toBeUndefined();
    expect(message.model).toBe("m1");
    expect(message.content).toEqual([
      { type: "thinking", text: "done" },
      { type: "text", text: "answer" },
    ]);
    expect(v.totals.cost_usd).toBe(0.5);
  });

  test("a partial snapshot still resolves into the final message", () => {
    const v = projectSession([
      mk("s", "turn.assistant", {
        turn_id: "t",
        msg_id: "m1",
        partial: true,
        content: [{ type: "thinking", text: "…" }],
      }),
      mk("s", "turn.assistant", {
        turn_id: "t",
        msg_id: "m1",
        content: [
          { type: "thinking", text: "done" },
          { type: "text", text: "answer" },
        ],
        model: "m1",
      }),
    ]);
    expect(v.turns[0]!.assistant).toHaveLength(1);
    expect(v.turns[0]!.assistant[0]!.partial).toBeUndefined();
    expect(v.turns[0]!.assistant[0]!.content.at(-1)).toEqual({ type: "text", text: "answer" });
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

  test("rename, archive, and delete stick on the session", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w", title: "old" }),
      mk("s", "session.updated", { title: "new", workspace: "/other", archived: true }),
    ]);
    expect(v.title).toBe("new");
    expect(v.workspace).toBe("/other");
    expect(v.archived).toBe(true);
    const gone = projectSession([
      mk("s2", "session.started", { workspace: "/w", title: "keep" }),
      mk("s2", "session.deleted", {}),
    ]);
    expect(gone.deleted).toBe(true);
    expect(gone.title).toBe("keep");
  });

  test("a goal stays until a later event clears it", () => {
    const set = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "session.goal", { text: "ship the fix" }),
    ]);
    expect(set.goal).toBe("ship the fix");
    const cleared = projectSession([
      mk("s2", "session.started", { workspace: "/w" }),
      mk("s2", "session.goal", { text: "ship the fix" }),
      mk("s2", "session.goal", { text: null }),
    ]);
    expect(cleared.goal).toBeUndefined();
  });

  test("a met goal keeps its text, and a later goal starts over", () => {
    const met = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "session.goal", { text: "ship the fix" }),
      mk("s", "session.goal", { text: "ship the fix", met: true }),
    ]);
    expect(met.goal).toBe("ship the fix");
    expect(met.goal_met).toBe(true);
    expect(met.goal_seq).toBeGreaterThan(0);
    const said = projectSession([
      mk("s4", "session.started", { workspace: "/w" }),
      mk("s4", "turn.assistant", { turn_id: "t1", content: [{ type: "text", text: "GOAL MET" }] }),
    ]);
    expect(said.turns[0]!.assistant[0]!.seq).toBeGreaterThan(0);
    const again = projectSession([
      mk("s2", "session.started", { workspace: "/w" }),
      mk("s2", "session.goal", { text: "ship the fix", met: true }),
      mk("s2", "session.goal", { text: "ship the tests" }),
    ]);
    expect(again.goal).toBe("ship the tests");
    expect(again.goal_met).toBeUndefined();
    expect(again.goal_seq).toBeGreaterThan(0);
    const cleared = projectSession([
      mk("s3", "session.started", { workspace: "/w" }),
      mk("s3", "session.goal", { text: "ship the fix", met: true }),
      mk("s3", "session.goal", { text: null }),
    ]);
    expect(cleared.goal).toBeUndefined();
    expect(cleared.goal_met).toBeUndefined();
    expect(cleared.goal_seq).toBeUndefined();
    expect(cleared.goal_paused).toBeUndefined();
  });

  test("pausing a goal keeps the text and a later goal starts again", () => {
    const paused = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "session.goal", { text: "ship the fix" }),
      mk("s", "session.goal", { text: "ship the fix", paused: true }),
    ]);
    expect(paused.goal).toBe("ship the fix");
    expect(paused.goal_paused).toBe(true);
    expect(paused.goal_met).toBeUndefined();
    const resumed = projectSession([
      mk("s2", "session.started", { workspace: "/w" }),
      mk("s2", "session.goal", { text: "ship the fix", paused: true }),
      mk("s2", "session.goal", { text: "ship the fix" }),
    ]);
    expect(resumed.goal).toBe("ship the fix");
    expect(resumed.goal_paused).toBeUndefined();
    const cleared = projectSession([
      mk("s3", "session.started", { workspace: "/w" }),
      mk("s3", "session.goal", { text: "ship the fix", paused: true }),
      mk("s3", "session.goal", { text: null }),
    ]);
    expect(cleared.goal).toBeUndefined();
    expect(cleared.goal_paused).toBeUndefined();
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

  test("a revert on t1 greys t1 and every turn after it", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "turn.user", { turn_id: "t0", content: [{ type: "text", text: "before" }] }),
      mk("s", "turn.user", { turn_id: "t1", content: [{ type: "text", text: "here" }] }),
      mk("s", "turn.user", { turn_id: "t2", content: [{ type: "text", text: "after" }] }),
      mk("s", "session.updated", { revert: { turn_id: "t1" } }),
    ]);
    expect(v.revert_turn_id).toBe("t1");
    expect(v.turns.map((t) => t.reverted)).toEqual([undefined, true, true]);
  });

  test("a later title update keeps the revert", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w", title: "old" }),
      mk("s", "turn.user", { turn_id: "t1", content: [{ type: "text", text: "hi" }] }),
      mk("s", "session.updated", { revert: { turn_id: "t1" } }),
      mk("s", "session.updated", { title: "new" }),
    ]);
    expect(v.title).toBe("new");
    expect(v.revert_turn_id).toBe("t1");
    expect(v.turns[0]!.reverted).toBe(true);
  });

  test("revert null clears the boundary", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "turn.user", { turn_id: "t1", content: [{ type: "text", text: "hi" }] }),
      mk("s", "session.updated", { revert: { turn_id: "t1" } }),
      mk("s", "session.updated", { revert: null }),
    ]);
    expect(v.revert_turn_id).toBeUndefined();
    expect(v.turns[0]!.reverted).toBeUndefined();
  });

  test("an assistant message id greys that turn and the ones after it", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "turn.user", { turn_id: "t0", content: [{ type: "text", text: "before" }] }),
      mk("s", "turn.assistant", {
        turn_id: "t1",
        msg_id: "msg_a",
        content: [{ type: "text", text: "yo" }],
      }),
      mk("s", "turn.user", { turn_id: "t2", content: [{ type: "text", text: "after" }] }),
      mk("s", "session.updated", { revert: { turn_id: "msg_a" } }),
    ]);
    expect(v.turns.map((t) => t.reverted)).toEqual([undefined, true, true]);
  });

  test("edits on a reverted turn leave files_changed", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "turn.user", { turn_id: "t0", content: [] }),
      mk("s", "tool.call", { turn_id: "t0", call_id: "c0", tool: "edit", input: {} }),
      mk("s", "file.changed", { path: "keep.ts", change: "modify", call_id: "c0" }),
      mk("s", "turn.user", { turn_id: "t1", content: [] }),
      mk("s", "tool.call", { turn_id: "t1", call_id: "c1", tool: "edit", input: {} }),
      mk("s", "file.changed", { path: "gone.ts", change: "add", call_id: "c1" }),
      mk("s", "file.changed", { path: "keep.ts", change: "delete", call_id: "c1" }),
      // no call, so turn_index is -1 and the edit stays even after the boundary
      mk("s", "file.changed", { path: "shell.ts", change: "modify" }),
      mk("s", "session.updated", { revert: { turn_id: "t1" } }),
    ]);
    expect(v.files_changed.map((f) => f.path)).toEqual(["keep.ts", "shell.ts"]);
    const keep = v.files_changed[0]!;
    expect(keep.edits.map((e) => e.turn_index)).toEqual([0]);
    expect(keep.change).toBe("modify");
    expect(keep.count).toBe(1);
    expect(v.files_changed[1]!.edits[0]!.turn_index).toBe(-1);
  });

  test("session.compacted marks that turn with its cause", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "turn.user", { turn_id: "t1", content: [{ type: "text", text: "hi" }] }),
      mk("s", "turn.user", { turn_id: "t2", content: [{ type: "text", text: "later" }] }),
      mk("s", "session.compacted", { message_id: "t1", auto: true, overflow: true }),
    ]);
    expect(v.turns[0]!.compaction).toEqual({ auto: true, overflow: true });
    expect(v.turns[1]!.compaction).toBeUndefined();
  });

  test("an older session.compacted without the new fields still marks the turn", () => {
    // Events written before `auto`/`overflow` existed replay as {}-ish data —
    // the turn still gets its divider, just without a cause to name.
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "turn.user", { turn_id: "t1", content: [] }),
      mk("s", "session.compacted", { message_id: "t1" }),
    ]);
    expect(v.turns[0]!.compaction).toEqual({});
  });

  test("a summary flag on turn.assistant survives a partial replace", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "turn.user", { turn_id: "t1", content: [] }),
      mk("s", "turn.assistant", {
        turn_id: "t1",
        msg_id: "m1",
        partial: true,
        summary: true,
        content: [{ type: "text", text: "…" }],
      }),
      mk("s", "turn.assistant", {
        turn_id: "t1",
        msg_id: "m1",
        summary: true,
        content: [{ type: "text", text: "the summary" }],
      }),
    ]);
    expect(v.turns[0]!.assistant).toHaveLength(1);
    expect(v.turns[0]!.assistant[0]!.summary).toBe(true);
  });

  test("steps and structured data ride the final message and survive its partials", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "turn.user", { turn_id: "t1", content: [] }),
      // A mid-stream snapshot knows nothing of either yet.
      mk("s", "turn.assistant", {
        turn_id: "t1",
        msg_id: "m1",
        partial: true,
        content: [{ type: "text", text: "…" }],
      }),
      mk("s", "turn.assistant", {
        turn_id: "t1",
        msg_id: "m1",
        content: [{ type: "text", text: "done" }],
        steps: [
          { reason: "tool-calls", usage: { input: 10, output: 5 }, cost_usd: 0.01 },
          { reason: "stop", usage: { input: 20, output: 8 }, cost_usd: 0.02 },
        ],
        structured: { answer: 42 },
      }),
    ]);
    const a = v.turns[0]!.assistant[0]!;
    expect(a.steps).toHaveLength(2);
    expect(a.steps![1]!.reason).toBe("stop");
    expect(a.structured).toEqual({ answer: 42 });
    // Steps are detail, not a contribution — the message-level usage is the
    // only thing totals counts.
    expect(v.totals.input).toBe(0);
  });

  test("a null structured answer survives the partial replace", () => {
    // `null` is a legitimate json_schema reply. Treating it as "absent" on
    // the replace path dropped it before it could reach the reader.
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "turn.user", { turn_id: "t1", content: [] }),
      mk("s", "turn.assistant", {
        turn_id: "t1",
        msg_id: "m1",
        partial: true,
        content: [{ type: "text", text: "…" }],
      }),
      mk("s", "turn.assistant", {
        turn_id: "t1",
        msg_id: "m1",
        content: [{ type: "text", text: "done" }],
        structured: null,
      }),
    ]);
    expect(v.turns[0]!.assistant[0]!.structured).toBeNull();
  });

  test("a tool result's attachments land on the call", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "turn.user", { turn_id: "t1", content: [] }),
      mk("s", "tool.call", { turn_id: "t1", call_id: "c1", tool: "browser", input: {} }),
      mk("s", "tool.result", {
        call_id: "c1",
        status: "ok",
        output: "ok",
        attachments: [{ type: "file_ref", path: "shot.png", mime: "image/png" }],
      }),
    ]);
    expect(v.turns[0]!.tool_calls[0]!.attachments).toEqual([
      { type: "file_ref", path: "shot.png", mime: "image/png" },
    ]);
  });

  test("a subtask prompt gives an untitled session its name", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "turn.user", {
        turn_id: "t1",
        content: [{ type: "subtask", prompt: "find the auth flow", agent: "explore" }],
      }),
    ]);
    expect(v.title).toBe("find the auth flow");
  });

  test("retry state projects and a busy frame retires it", () => {
    const retry = { attempt: 2, message: "rate limited", next: 1760966430000 };
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "session.status", { state: "retry", retry }),
    ]);
    expect(v.busy).toBe(true);
    expect(v.retry).toEqual(retry);
    const resumed = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "session.status", { state: "retry", retry }),
      mk("s", "session.status", { state: "busy" }),
    ]);
    expect(resumed.retry).toBeUndefined();
    expect(resumed.busy).toBe(true);
  });

  test("session.error stills the session and stays put on idle", () => {
    // The failure is the thing a reader came back for — a bare idle must not
    // quietly stand in for it. New work is what clears it.
    const err = { name: "ProviderAuthError", message: "bad key", statusCode: 401 };
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "session.status", { state: "busy" }),
      mk("s", "session.error", { error: err }),
      mk("s", "session.status", { state: "idle" }),
    ]);
    expect(v.busy).toBe(false);
    expect(v.session_error).toEqual(err);
    const healed = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "session.error", { error: err }),
      mk("s", "turn.user", { turn_id: "t1", content: [] }),
    ]);
    expect(healed.session_error).toBeUndefined();
  });

  test("a compacting status sets the flag and the next state drops it", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "session.status", { state: "compacting" }),
    ]);
    expect(v.compacting).toBe(true);
    expect(v.busy).toBe(true);
    const done = projectSession([
      mk("s", "session.started", { workspace: "/w" }),
      mk("s", "session.status", { state: "compacting" }),
      mk("s", "session.status", { state: "busy" }),
    ]);
    expect(done.compacting).toBeUndefined();
    expect(done.busy).toBe(true);
  });

  test("entries carry the ts of the event that wrote them", () => {
    const v = projectSession([
      mk("s", "session.started", { workspace: "/w" }, "2026-01-01T00:00:00Z"),
      mk("s", "turn.user", { turn_id: "t1", content: [] }, "2026-01-01T00:00:01Z"),
      mk(
        "s",
        "turn.assistant",
        { turn_id: "t1", msg_id: "m1", partial: true, content: [{ type: "text", text: "…" }] },
        "2026-01-01T00:00:02Z",
      ),
      mk(
        "s",
        "turn.assistant",
        { turn_id: "t1", msg_id: "m1", content: [{ type: "text", text: "done" }] },
        "2026-01-01T00:00:05Z",
      ),
      mk("s", "tool.call", { turn_id: "t1", call_id: "c1", tool: "bash", input: {} }, "2026-01-01T00:00:03Z"),
      mk("s", "tool.result", { call_id: "c1", status: "ok" }, "2026-01-01T00:00:04Z"),
    ]);
    // The replacing snapshot keeps one entry and takes the newer ts.
    expect(v.turns[0]!.assistant).toHaveLength(1);
    expect(v.turns[0]!.assistant[0]!.ts).toBe("2026-01-01T00:00:05Z");
    // A call is stamped when it is declared; its result does not move it.
    expect(v.turns[0]!.tool_calls[0]!.ts).toBe("2026-01-01T00:00:03Z");
  });
});
