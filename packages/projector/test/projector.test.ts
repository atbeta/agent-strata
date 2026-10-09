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

  test("a call recorded before its message existed still finds that message", () => {
    // Sessions stored before msg_id existed have calls with no message at all,
    // and re-importing cannot add the field — the store keeps the first body it
    // saw for an event id. A message streams: partials, then the calls it
    // declared, then a final record when it completes. So a call belongs to
    // the first message that had not finished by the time it was made.
    const v = projectSession([
      mk("s", "turn.user", { turn_id: "t", content: [] }),
      mk("s", "turn.assistant", { turn_id: "t", msg_id: "m1", content: [], partial: true }),
      mk("s", "tool.call", { turn_id: "t", call_id: "c1", tool: "bash", input: {}, order: 0 }),
      mk("s", "turn.assistant", { turn_id: "t", msg_id: "m1", content: [] }),
      mk("s", "turn.assistant", { turn_id: "t", msg_id: "m2", content: [], partial: true }),
      mk("s", "tool.call", { turn_id: "t", call_id: "c2", tool: "read", input: {}, order: 0 }),
      mk("s", "turn.assistant", { turn_id: "t", msg_id: "m2", content: [] }),
    ]);
    expect(v.turns[0]!.tool_calls.map((c) => [c.call_id, c.msg_id])).toEqual([
      ["c1", "m1"],
      ["c2", "m2"],
    ]);
  });

  test("a call made before any message appeared belongs to the one that finished first", () => {
    const v = projectSession([
      mk("s", "turn.user", { turn_id: "t", content: [] }),
      mk("s", "tool.call", { turn_id: "t", call_id: "c1", tool: "bash", input: {}, order: 0 }),
      mk("s", "turn.assistant", { turn_id: "t", msg_id: "m1", content: [] }),
      mk("s", "turn.assistant", { turn_id: "t", msg_id: "m2", content: [] }),
    ]);
    expect(v.turns[0]!.tool_calls.map((c) => c.msg_id)).toEqual(["m1"]);
  });

  test("a message the backend named wins over the sequence guess", () => {
    const v = projectSession([
      mk("s", "turn.assistant", { turn_id: "t", msg_id: "m1", content: [] }),
      mk("s", "turn.assistant", { turn_id: "t", msg_id: "m2", content: [] }),
      // recorded before m1 and m2 but declared as belonging to m2
      mk("s", "tool.call", { turn_id: "t", call_id: "c1", tool: "bash", input: {}, order: 0, msg_id: "m2" }),
    ]);
    expect(v.turns[0]!.tool_calls.map((c) => c.msg_id)).toEqual(["m2"]);
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

  test("a change with no diff is rebuilt from the edit call that made it", () => {
    const v = projectSession([
      mk("s", "tool.call", {
        turn_id: "t1",
        call_id: "c1",
        tool: "edit",
        input: { filePath: "src/x.ts", oldString: "const a = 1", newString: "const a = 2" },
      }),
      mk("s", "file.changed", { path: "src/x.ts", change: "modify" }),
    ]);
    const f = v.files_changed[0]!;
    expect(f.unexplained).toBe(false);
    expect(f.additions).toBe(1);
    expect(f.deletions).toBe(1);
    expect(f.edits[0]!.diff).toContain("-const a = 1");
    expect(f.edits[0]!.diff).toContain("+const a = 2");
    expect(f.edits[0]!.whole_file).toBe(false);
    // the reader can walk from the file back to the turn that changed it
    expect(f.edits[0]!.turn_index).toBe(0);
  });

  test("a whole-file write is labelled differently from an in-place edit", () => {
    const v = projectSession([
      mk("s", "tool.call", {
        turn_id: "t1",
        call_id: "c1",
        tool: "write",
        input: { filePath: "new.ts", content: "a\nb\n" },
      }),
      mk("s", "file.changed", { path: "new.ts", change: "add" }),
    ]);
    const edit = v.files_changed[0]!.edits[0]!;
    expect(edit.whole_file).toBe(true);
    expect(edit.additions).toBe(2);
    expect(edit.deletions).toBe(0);
  });

  test("the two path spellings of one file still match", () => {
    // OpenCode writes the changed path with forward slashes while the tool
    // input it sits beside uses the platform's own separators.
    const v = projectSession([
      mk("s", "tool.call", {
        turn_id: "t1",
        call_id: "c1",
        tool: "edit",
        input: { filePath: "D:\\Repo\\src\\x.ts", oldString: "a", newString: "b" },
      }),
      mk("s", "file.changed", { path: "D:/repo/src/x.ts", change: "modify" }),
    ]);
    expect(v.files_changed[0]!.unexplained).toBe(false);
    expect(v.files_changed[0]!.edits[0]!.diff).toContain("+b");
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

  test("an edit call with no change event is still a change that happened", () => {
    const v = projectSession([
      mk("s", "tool.call", {
        turn_id: "t1",
        call_id: "c1",
        tool: "edit",
        input: { filePath: "x.ts", oldString: "a", newString: "b" },
      }),
      mk("s", "tool.call", {
        turn_id: "t1",
        call_id: "c2",
        tool: "bash",
        input: { command: "ls" },
      }),
      mk("s", "file.changed", { path: "x.ts", change: "modify" }),
    ]);
    // only the edit call is consumed by the one recorded change
    expect(v.files_changed[0]!.edits).toHaveLength(1);
    expect(v.files_changed[0]!.unexplained).toBe(false);
  });

  test("a diff the backend already sent is used as-is, never rebuilt", () => {
    const v = projectSession([
      mk("s", "tool.call", {
        turn_id: "t1",
        call_id: "c1",
        tool: "edit",
        input: { filePath: "x.ts", oldString: "a", newString: "b" },
      }),
      mk("s", "file.changed", { path: "x.ts", change: "modify", diff: "the backend's own patch" }),
    ]);
    expect(v.files_changed[0]!.edits[0]!.diff).toBe("the backend's own patch");
    // the leftover edit call is a separate change, not a second reading of this one
    expect(v.files_changed[0]!.edits).toHaveLength(2);
  });

  test("a file changed twice gets both diffs, in order", () => {
    const v = projectSession([
      mk("s", "tool.call", {
        turn_id: "t1", call_id: "c1", tool: "edit",
        input: { filePath: "x.ts", oldString: "a", newString: "b" },
      }),
      mk("s", "file.changed", { path: "x.ts", change: "modify" }),
      mk("s", "tool.call", {
        turn_id: "t2", call_id: "c2", tool: "edit",
        input: { filePath: "x.ts", oldString: "b", newString: "c" },
      }),
      mk("s", "file.changed", { path: "x.ts", change: "modify" }),
    ]);
    const f = v.files_changed[0]!;
    expect(f.count).toBe(2);
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(2);
    expect(f.edits.map((e) => e.turn_index)).toEqual([0, 1]);
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
