import { describe, expect, test } from "bun:test";
import { makeEvent, type EventInput } from "@agent-strata/schema";
import { openStore } from "@agent-strata/store";
import { projectSession } from "@agent-strata/projector";
import { compareSessions, exportEvents } from "../src/index";

const mk = (session_id: string, type: string, data: object, ts: string, backend = "test"): EventInput =>
  makeEvent({
    session_id,
    ts,
    source: { backend },
    type,
    data,
  } as EventInput);

const seedSession = (s: ReturnType<typeof openStore>, id: string, backend = "test") =>
  s.append([
    mk(id, "session.started", { workspace: "/w" }, "2026-01-01T00:00:00Z", backend),
    mk(id, "turn.user", { turn_id: "t1", content: [{ type: "text", text: "fix the auth bug" }] }, "2026-01-01T00:01:00Z", backend),
    mk(id, "tool.call", { turn_id: "t1", call_id: "c1", tool: "bash", input: { command: "ls" } }, "2026-01-01T00:02:00Z", backend),
    mk(id, "tool.result", { turn_id: "t1", call_id: "c1", status: "ok", output: "x" }, "2026-01-01T00:03:00Z", backend),
    mk(id, "turn.assistant", {
      turn_id: "t1",
      content: [{ type: "text", text: "done" }],
      model: "deepseek/deepseek-flash",
      usage: { input: 100, output: 50 },
      cost_usd: 0.001,
      latency_ms: 900,
    }, "2026-01-01T00:04:00Z", backend),
  ]);

describe("exportEvents", () => {
  test("jsonl with header, one event per line, stable ids", () => {
    const s = openStore(":memory:");
    seedSession(s, "a");
    const out = exportEvents(s, { session_id: "a" });
    const lines = out.trimEnd().split("\n");
    expect(lines.length).toBe(6);
    const header = JSON.parse(lines[0]!);
    expect(header.casf).toBe("0.1");
    expect(header.event_count).toBe(5);
    const ev = JSON.parse(lines[1]!);
    expect(ev.type).toBe("session.started");
    expect(ev.seq).toBe(1);
    s.close();
  });

  test("re-importing exported events is a no-op", () => {
    const s = openStore(":memory:");
    seedSession(s, "a");
    const out = exportEvents(s, { session_id: "a", include_header: false });
    const events = out
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as EventInput);
    const before = s.read({ session_id: "a" });
    s.append(events);
    expect(s.read({ session_id: "a" }).length).toBe(before.length);
    s.close();
  });

  test("secret in tool output is redacted by default, kept when disabled", () => {
    const s = openStore(":memory:");
    s.append([
      mk("a", "session.started", { workspace: "/w" }, "2026-01-01T00:00:00Z"),
      mk("a", "tool.call", { turn_id: "t", call_id: "c", tool: "bash", input: {} }, "2026-01-01T00:01:00Z"),
      mk("a", "tool.result", { turn_id: "t", call_id: "c", status: "ok", output: "key=sk-abcdefghijklmnopqrstuvwx" }, "2026-01-01T00:02:00Z"),
    ]);
    const redacted = exportEvents(s, { session_id: "a", include_header: false });
    expect(redacted).not.toContain("sk-abcdefghij");
    expect(redacted).toContain("[redacted]");
    const raw = exportEvents(s, { session_id: "a", include_header: false, redact: false });
    expect(raw).toContain("sk-abcdefghij");
    s.close();
  });

  test("filters by backend and time", () => {
    const s = openStore(":memory:");
    seedSession(s, "a", "opencode");
    seedSession(s, "b", "acp");
    expect(exportEvents(s, { backend: "acp", include_header: false }).trimEnd().split("\n").length).toBe(5);
    expect(
      exportEvents(s, { session_id: "a", until: "2026-01-01T00:02:00Z", include_header: false })
        .trimEnd()
        .split("\n").length,
    ).toBe(3);
    s.close();
  });
});

describe("compareSessions", () => {
  const viewFor = (s: ReturnType<typeof openStore>, id: string, backend = "test") => {
    seedSession(s, id, backend);
    return projectSession(s.read({ session_id: id }));
  };

  test("same prompt pairs turns and reports tool usage", () => {
    const s = openStore(":memory:");
    const a = viewFor(s, "a", "opencode");
    const b = viewFor(s, "b", "acp");
    const cmp = compareSessions(a, b);
    expect(cmp.a.backend).toBe("opencode");
    expect(cmp.b.backend).toBe("acp");
    expect(cmp.a.model).toBe("deepseek/deepseek-flash");
    expect(cmp.summary.turn_pairs).toBe(1);
    expect(cmp.summary.same_prompt).toBe(1);
    expect(cmp.summary.shared_tools).toEqual(["bash"]);
    expect(cmp.summary.delta_totals.cost_usd).toBeCloseTo(0);
    const pair = cmp.turn_pairs[0]!;
    expect(pair.a_turn!.turn_id).toBe("t1");
    expect(pair.b_turn!.turn_id).toBe("t1");
    expect(pair.delta.input).toBe(0);
    expect(pair.delta.duration_ms).toBe(0);
    s.close();
  });

  test("different prompt and asymmetric turns/tools", () => {
    const s = openStore(":memory:");
    const a = viewFor(s, "a");
    s.append([
      mk("b", "session.started", { workspace: "/w" }, "2026-01-01T00:00:00Z"),
      mk("b", "turn.user", { turn_id: "t1", content: [{ type: "text", text: "different task" }] }, "2026-01-01T00:01:00Z"),
      mk("b", "tool.call", { turn_id: "t1", call_id: "c9", tool: "edit", input: {} }, "2026-01-01T00:02:00Z"),
      mk("b", "turn.user", { turn_id: "t2", content: [{ type: "text", text: "follow-up" }] }, "2026-01-01T00:03:00Z"),
    ]);
    const b = projectSession(s.read({ session_id: "b" }));
    const cmp = compareSessions(a, b);
    expect(cmp.summary.same_prompt).toBe(0);
    expect(cmp.summary.only_a_tools).toEqual(["bash"]);
    expect(cmp.summary.only_b_tools).toEqual(["edit"]);
    expect(cmp.turn_pairs.length).toBe(2);
    const extra = cmp.turn_pairs[1]!;
    expect(extra.a_turn).toBeNull();
    expect(extra.b_turn!.turn_id).toBe("t2");
    s.close();
  });
});
