import { describe, expect, test } from "bun:test";
import { filterTrace, layoutTrace, traceBlocks, type TraceSourceEvent } from "./trace-model";
import { mergeTraceEvents } from "./trace-data";

let seq = 0;
const ev = (type: string, data: Record<string, unknown>, ts?: number): TraceSourceEvent => ({
  id: `e${++seq}`,
  session_id: "s",
  type,
  seq,
  ts: new Date(ts === undefined ? seq * 1_000 : ts).toISOString(),
  data,
});
const at = (ms: number) => new Date(ms).toISOString();

const user = (turn: string, s = ++seq) =>
  ev("turn.user", { turn_id: turn, content: [{ type: "text", text: `prompt ${turn}` }] });
const assistant = (
  turn: string,
  msg: string,
  extra: Record<string, unknown> = {},
  ts?: number,
) =>
  ev(
    "turn.assistant",
    {
      turn_id: turn,
      msg_id: msg,
      content: [{ type: "text", text: `reply ${msg}` }],
      model: "prov/model-x",
      ...extra,
    },
    ts,
  );
const call = (turn: string, id: string, tool = "bash", extra: Record<string, unknown> = {}, ts?: number) =>
  ev("tool.call", { turn_id: turn, call_id: id, tool, input: { command: `run ${id}` }, ...extra }, ts);
const result = (id: string, status = "ok", extra: Record<string, unknown> = {}, ts?: number) =>
  ev("tool.result", { call_id: id, status, output: `out ${id}`, ...extra }, ts);

describe("traceBlocks", () => {
  test("numbers turns by first appearance and steps within them", () => {
    const blocks = traceBlocks([
      user("t1"),
      assistant("t1", "m1"),
      call("t1", "c1"),
      result("c1"),
      user("t2"),
      assistant("t2", "m2"),
    ]);
    const byKey = new Map(blocks.map((b) => [b.key, b]));
    expect(byKey.get("u:t1")?.turn).toBe(1);
    expect(byKey.get("a:m1")).toMatchObject({ turn: 1, step: 1 });
    expect(byKey.get("t:c1")).toMatchObject({ turn: 1, step: 2 });
    expect(byKey.get("u:t2")?.turn).toBe(2);
    expect(byKey.get("u:t2")?.step).toBeUndefined();
    expect(byKey.get("a:m2")).toMatchObject({ turn: 2, step: 1 });
  });

  test("a tool keeps its call start after the result lands", () => {
    const callTs = 10_000;
    const resultTs = 12_500;
    const blocks = traceBlocks([
      call("t1", "c1", "bash", {}, callTs),
      result("c1", "ok", { latency_ms: 2_500 }, resultTs),
    ]);
    const tool = blocks.find((b) => b.key === "t:c1")!;
    expect(tool.startTs).toBe(callTs);
    expect(tool.endTs).toBe(resultTs);
    expect(tool.seq).toBeGreaterThan(tool.firstSeq);
    expect(tool.status).toBe("ok");
  });

  test("statuses: ok / error / interrupted / pending", () => {
    const blocks = traceBlocks([
      call("t1", "ok1", "read", {}, 1_000), result("ok1", "ok", {}, 2_000),
      call("t1", "bad1", "bash", {}, 3_000), result("bad1", "error", {}, 4_000),
      call("t1", "int1", "bash", {}, 5_000), result("int1", "interrupted", {}, 6_000),
      call("t1", "pend1", "bash", {}, 7_000),
    ]);
    const at_ = (k: string) => blocks.find((b) => b.key === `t:${k}`)!.status;
    expect(at_("ok1")).toBe("ok");
    expect(at_("bad1")).toBe("error");
    expect(at_("int1")).toBe("interrupted");
    expect(at_("pend1")).toBe("pending");
  });

  test("normal shell and dev calls are not warnings; results own error tones", () => {
    const blocks = traceBlocks([
      call("t1", "shell", "bash", {}, 1_000),
      result("shell", "ok", {}, 2_000),
      call("t1", "dev", "dev-process", {}, 3_000),
      call("t1", "bad", "zsh", {}, 4_000),
      result("bad", "error", {}, 5_000),
      call("t1", "stop", "powershell", {}, 6_000),
      result("stop", "interrupted", {}, 7_000),
    ]);
    const tone = (id: string) => blocks.find((b) => b.key === `t:${id}`)!.tone;
    expect(tone("shell")).toBe("bg-primary");
    expect(tone("dev")).toBe("bg-primary");
    expect(tone("bad")).toBe("bg-status-error");
    expect(tone("stop")).toBe("bg-status-cancelled");
  });

  test("assistant error, summary flag and thinking clock", () => {
    const blocks = traceBlocks([
      assistant("t1", "m1", {
        error: "provider exploded",
        summary: true,
        content: [
          { type: "thinking", text: "hmm", started_ms: 100, ended_ms: 700 },
          { type: "thinking", text: "no clock" },
          { type: "text", text: "answer" },
        ],
      }, 9_000),
    ]);
    const b = blocks.find((x) => x.key === "a:m1")!;
    expect(b.status).toBe("error");
    expect(b.errorText).toBe("provider exploded");
    expect(b.summary).toBe(true);
    expect(b.titleKey).toBe("trace.event.summary");
    expect(b.thinking).toContain("hmm");
    expect(b.thinkingMs).toBe(600);
  });

  test("file.changed attaches by call_id, else becomes a marker", () => {
    const blocks = traceBlocks([
      call("t1", "c1", "edit", {}, 1_000),
      result("c1", "ok", {}, 2_000),
      ev("file.changed", { path: "a.ts", change: "modify", call_id: "c1" }, 3_000),
      ev("file.changed", { path: "b.ts", change: "add", diff: "+x" }, 4_000),
    ]);
    const tool = blocks.find((b) => b.key === "t:c1")!;
    expect(tool.files).toEqual([{ path: "a.ts", change: "modify", diff: undefined, whole_file: undefined }]);
    const marker = blocks.find((b) => b.kind === "file")!;
    expect(marker.lane).toBe("event");
    expect(marker.tone).toBe("bg-event-file");
    expect(marker.preview).toBe("b.ts");
    expect(marker.files?.[0]?.diff).toBe("+x");
  });

  test("permission attaches to the tool; a lone request becomes a marker; deny tints", () => {
    const blocks = traceBlocks([
      call("t1", "c1", "bash", {}, 1_000),
      ev("permission.requested", { request_id: "p1", call_id: "c1", tool: "bash", input: {} }, 2_000),
      ev("permission.resolved", { request_id: "p1", decision: "allow", by: "user" }, 3_000),
      ev("permission.requested", { request_id: "p2", tool: "write", input: {} }, 4_000),
      ev("permission.resolved", { request_id: "p2", decision: "deny", by: "policy", rule_id: "r9" }, 5_000),
    ]);
    const tool = blocks.find((b) => b.key === "t:c1")!;
    expect(tool.permission).toMatchObject({ decision: "allow", by: "user" });
    expect(tool.denied).toBeUndefined();
    const marker = blocks.find((b) => b.kind === "permission")!;
    expect(marker.status).toBe("error");
    expect(marker.denied).toBe(true);
    expect(marker.tone).toBe("bg-status-error");
    expect(marker.permission).toMatchObject({ decision: "deny", rule_id: "r9" });
  });

  test("consecutive retries collapse into one marker with a count", () => {
    const blocks = traceBlocks([
      ev("session.status", { state: "retry", retry: { attempt: 1, message: "one" } }, 1_000),
      ev("session.status", { state: "retry", retry: { attempt: 2, message: "two" } }, 2_000),
      ev("session.status", { state: "busy" }, 3_000),
      ev("session.status", { state: "retry", retry: { attempt: 3, message: "three" } }, 4_000),
    ]);
    const retries = blocks.filter((b) => b.kind === "retry");
    expect(retries.length).toBe(2);
    expect(retries[0]).toMatchObject({ count: 2, preview: "two", tone: "bg-status-cancelled" });
    expect(retries[1]).toMatchObject({ count: 1, preview: "three" });
  });

  test("session.error null clears are skipped; busy/idle are ignored", () => {
    const blocks = traceBlocks([
      ev("session.status", { state: "busy" }, 1_000),
      ev("session.error", { error: null }, 2_000),
      ev("session.error", { error: { message: "boom", statusCode: 500 } }, 3_000),
      ev("session.status", { state: "idle" }, 4_000),
      ev("session.status", { state: "compacting" }, 5_000),
    ]);
    expect(blocks.filter((b) => b.kind === "error").length).toBe(1);
    expect(blocks.find((b) => b.kind === "error")).toMatchObject({
      status: "error",
      tone: "bg-status-error",
      preview: "boom",
    });
    expect(blocks.filter((b) => b.kind === "compacting").length).toBe(1);
  });

  test("childSessionId comes through from call or result", () => {
    const blocks = traceBlocks([
      call("t1", "c1", "task", { child_session_id: "kid-1" }, 1_000),
      result("c1", "ok", {}, 2_000),
      call("t1", "c2", "task", {}, 3_000),
      result("c2", "ok", { child_session_id: "kid-2" }, 4_000),
    ]);
    expect(blocks.find((b) => b.key === "t:c1")!.childSessionId).toBe("kid-1");
    expect(blocks.find((b) => b.key === "t:c2")!.childSessionId).toBe("kid-2");
  });

  test("tool parentKey names the assistant block by msg_id", () => {
    const blocks = traceBlocks([
      assistant("t1", "m1", {}, 1_000),
      call("t1", "c1", "bash", { msg_id: "m1" }, 2_000),
    ]);
    expect(blocks.find((b) => b.key === "t:c1")!.parentKey).toBe("a:m1");
  });

  test("compacted / goal / plan markers carry their payload", () => {
    const blocks = traceBlocks([
      user("t1"),
      ev("session.compacted", { message_id: "m0", auto: true }, 2_000),
      ev("session.goal", { text: "ship it", met: true }, 3_000),
      ev("plan.updated", { entries: [{ content: "step one", status: "in_progress" }] }, 4_000),
    ]);
    expect(blocks.find((b) => b.kind === "compacted")).toMatchObject({
      tone: "bg-status-completed",
      preview: "auto",
    });
    expect(blocks.find((b) => b.kind === "goal")).toMatchObject({
      tone: "bg-event-assistant",
      preview: "ship it",
    });
    expect(blocks.find((b) => b.kind === "plan")).toMatchObject({
      tone: "bg-muted-foreground",
      preview: "step one",
    });
  });
});

describe("filterTrace", () => {
  const blocks = () =>
    traceBlocks([
      user("t1"),
      call("t1", "c1", "bash", {}, 2_000),
      result("c1", "error", { output: "exploded violet" }, 3_000),
      call("t1", "c2", "read", {}, 4_000),
      result("c2", "ok", { output: "fine" }, 5_000),
    ]);

  test("kind tool keeps tools only; kind error keeps failures", () => {
    const bs = blocks();
    expect(filterTrace(bs, { query: "", kind: "tool" }).map((b) => b.lane)).toEqual([
      "tool",
      "tool",
    ]);
    expect(filterTrace(bs, { query: "", kind: "error" }).map((b) => b.key)).toEqual(["t:c1"]);
  });

  test("query matches title, preview and a string result", () => {
    const bs = blocks();
    expect(filterTrace(bs, { query: "BASH", kind: "all" }).map((b) => b.key)).toEqual(["t:c1"]);
    expect(filterTrace(bs, { query: "violet", kind: "all" }).map((b) => b.key)).toEqual(["t:c1"]);
    expect(filterTrace(bs, { query: "prompt t1", kind: "all" }).map((b) => b.key)).toEqual(["u:t1"]);
    expect(filterTrace(bs, { query: "nomatch", kind: "all" })).toEqual([]);
  });
});

describe("layoutTrace", () => {
  test("duration mode collapses gaps over 30s into a fixed break", () => {
    const blocks = traceBlocks([
      call("t1", "a", "bash", {}, 0),
      result("a", "ok", {}, 5_000),
      call("t1", "b", "bash", {}, 5_000 + 40_000),
      result("b", "ok", {}, 50_000 + 5_000),
    ]);
    const layout = layoutTrace(blocks, "duration");
    const pa = layout.pos.get("t:a")!;
    const pb = layout.pos.get("t:b")!;
    // 40s of idle folds into a 14px break rather than 80px of nothing.
    expect(layout.breaks.length).toBe(1);
    expect(layout.folds).toEqual([{ x: layout.breaks[0]!, durationMs: 40_000 }]);
    expect(pb.left - (pa.left + pa.width)).toBe(14);
  });

  test("overlapping tools get different tracks", () => {
    const blocks = traceBlocks([
      call("t1", "x", "bash", {}, 0),
      call("t1", "y", "read", {}, 1_000),
      result("x", "ok", {}, 4_000),
      result("y", "ok", {}, 5_000),
      call("t1", "z", "grep", {}, 6_000),
      result("z", "ok", {}, 7_000),
    ]);
    const layout = layoutTrace(blocks, "duration");
    expect(layout.pos.get("t:x")!.track).not.toBe(layout.pos.get("t:y")!.track);
    expect(layout.pos.get("t:z")!.track).toBe(0);
    expect(layout.tracks.tool).toBe(2);
  });

  test("sequence mode gives every block the same slot in seq order", () => {
    const blocks = traceBlocks([
      user("t1"),
      call("t1", "c1", "bash", {}, 2_000),
      result("c1", "ok", {}, 9_000),
      assistant("t1", "m1", {}, 20_000),
    ]);
    const layout = layoutTrace(blocks, "sequence");
    const widths = [...layout.pos.values()].map((p) => p.width);
    expect(new Set(widths).size).toBe(1);
    const lefts = blocks.map((b) => layout.pos.get(b.key)!.left).sort((a, b) => a - b);
    for (let i = 1; i < lefts.length; i++) {
      expect(lefts[i]! - lefts[i - 1]!).toBe(13);
    }
    expect(layout.turns.length).toBe(1);
  });

  test("instantaneous blocks remain visible with a six-pixel minimum", () => {
    const layout = layoutTrace(traceBlocks([call("t1", "instant", "bash", {}, 1_000)]), "duration");
    expect(layout.pos.get("t:instant")!.width).toBe(6);
  });

  test("turn metadata survives both modes and dense labels yield to their lines", () => {
    const blocks = traceBlocks(Array.from({ length: 8 }, (_, i) => user(`dense${i}`)));
    for (const mode of ["duration", "sequence"] as const) {
      const layout = layoutTrace(blocks, mode);
      expect(layout.turnLabels.map((mark) => mark.turn)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(layout.turnLabels.map((mark) => mark.x)).toEqual(layout.turns);
      expect(layout.turnLabels[0]!.showLabel).toBe(true);
      expect(layout.turnLabels.some((mark) => !mark.showLabel)).toBe(true);
      const shown = layout.turnLabels.filter((mark) => mark.showLabel);
      for (let i = 1; i < shown.length; i++) {
        expect(shown[i]!.x - shown[i - 1]!.x).toBeGreaterThanOrEqual(56);
      }
    }
  });

  test("folds keep wall time while ruler ticks count active time", () => {
    const blocks = traceBlocks([
      call("t1", "before", "bash", {}, 0),
      result("before", "ok", {}, 80_000),
      call("t2", "after", "bash", {}, 320_000),
      result("after", "ok", {}, 400_000),
    ]);
    const layout = layoutTrace(blocks, "duration");
    expect(layout.folds.map((fold) => fold.durationMs)).toEqual([240_000]);
    expect(layout.ruler.map((tick) => tick.ms)).toEqual([60_000, 120_000]);
    expect(layout.turnLabels.map((mark) => mark.turn)).toEqual([1, 2]);
  });
});

describe("layoutTrace at scale", () => {
  test("a 30-day span with thousands of gaps: bounded ruler, monotone positions", () => {
    // One block per hour for 30 days, every other hour a >30s silence → ~360 gaps.
    const blocks: Parameters<typeof layoutTrace>[0] = [];
    const HOUR = 3_600_000;
    for (let i = 0; i < 30 * 24; i++) {
      const s = i * 2 * HOUR;
      blocks.push({
        key: `b${i}`,
        seq: i + 1,
        firstSeq: i + 1,
        ts: at(s),
        startTs: s,
        endTs: s + 1_000,
        lane: "tool",
        turn: i + 1,
        status: "ok",
        title: "t",
        preview: "",
        tone: "bg-event-tool",
      });
    }
    const layout = layoutTrace(blocks, "duration");
    expect(layout.breaks.length).toBe(719);
    // ruler ticks bounded by width/110 + gaps — not the 30-day wall span
    // (a naive sweep would emit ~44k ticks here)
    expect(layout.ruler.length).toBeLessThanOrEqual(
      layout.breaks.length + Math.ceil(layout.width / 110),
    );
    expect(layout.ruler.length).toBeGreaterThan(0);
    let prev = -1;
    for (const b of blocks) {
      const x = layout.pos.get(b.key)!.left;
      expect(x).toBeGreaterThanOrEqual(prev);
      prev = x;
    }
    // folded: 720 breaks * 14px + bars, far under the ms-proportional span
    expect(layout.width).toBeLessThan(100_000);
  });
});

describe("mergeTraceEvents", () => {
  test("appends only events past the loaded tail", () => {
    const prev = [
      ev("turn.user", { turn_id: "t", content: [] }),
      ev("turn.user", { turn_id: "t", content: [] }),
    ];
    const next = [
      { ...prev[1]!, seq: 2 },
      ev("file.changed", { path: "x", change: "add" }),
    ];
    const merged = mergeTraceEvents(prev, next);
    expect(merged.appended).toBe(1);
    expect(merged.events.length).toBe(3);
    expect(mergeTraceEvents(prev, []).appended).toBe(0);
    expect(mergeTraceEvents(prev, [prev[0]!]).appended).toBe(0);
  });

  test("merges over a 100k-event tail without argument-spread blowups", () => {
    const prev = Array.from({ length: 100_000 }, (_, i) => ev("turn.user", { turn_id: "t", content: [] }));
    const next = [ev("file.changed", { path: "x", change: "add" })];
    const merged = mergeTraceEvents(prev, next);
    expect(merged.appended).toBe(1);
    expect(merged.events.length).toBe(100_001);
  });
});
