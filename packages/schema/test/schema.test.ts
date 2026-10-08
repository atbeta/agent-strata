import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SECRET_PATTERNS,
  EVENT_TYPES,
  makeEvent,
  parseEvent,
  safeParseEvent,
  redact,
  type Event,
} from "../src/index";

const base = {
  id: "01J000000000000000000000AA",
  session_id: "s1",
  seq: 1,
  ts: "2025-01-01T00:00:00.000Z",
  source: { backend: "opencode" },
};

const fixtures: Record<string, unknown> = {
  "session.started": { workspace: "/repo", title: "t", model: "m" },
  "session.ended": { reason: "completed" },
  "turn.user": { turn_id: "t1", content: [{ type: "text", text: "hi" }] },
  "turn.assistant": {
    turn_id: "t1",
    content: [{ type: "thinking", text: "hmm" }],
    model: "claude",
    usage: { input: 1, output: 2 },
    cost_usd: 0.01,
    latency_ms: 5,
    stop_reason: "end",
  },
  "tool.call": { turn_id: "t1", call_id: "c1", tool: "bash", input: { command: "ls" } },
  "tool.result": { call_id: "c1", status: "ok", output: "done", latency_ms: 3 },
  "permission.requested": {
    request_id: "r1",
    call_id: "c1",
    tool: "bash",
    input: { command: "rm" },
    options: ["allow", "deny"],
  },
  "permission.resolved": {
    request_id: "r1",
    decision: "allow",
    by: "user",
    scope: "once",
    rule_id: "x",
    reason: "ok",
  },
  "file.changed": { path: "a.ts", change: "modify", diff: "@@" },
  "plan.updated": { entries: [{ content: "do", status: "pending" }] },
};

describe("schema", () => {
  test("valid fixture per event type parses", () => {
    for (const [type, data] of Object.entries(fixtures)) {
      const e = parseEvent({ ...base, type, data });
      expect(e.type as string).toBe(type);
      expect(e.data).toEqual(data as never);
    }
    expect([...EVENT_TYPES].sort() as unknown).toEqual(Object.keys(fixtures).sort());
  });

  test("unknown type rejected", () => {
    expect(safeParseEvent({ ...base, type: "nope", data: {} }).success).toBe(false);
  });

  test("image requires exactly one of data/uri", () => {
    const img = (o: object) => ({ ...base, type: "turn.user", data: { turn_id: "t", content: [{ type: "image", mime: "image/png", ...o }] } });
    expect(() => parseEvent(img({}))).toThrow();
    expect(() => parseEvent(img({ data: "a", uri: "u" }))).toThrow();
    expect(parseEvent(img({ data: "a" })).type).toBe("turn.user");
    expect(parseEvent(img({ uri: "u" })).type).toBe("turn.user");
  });

  test("negative usage rejected", () => {
    const e = {
      ...base,
      type: "turn.assistant",
      data: { turn_id: "t", content: [], usage: { input: -1, output: 0 } },
    };
    expect(() => parseEvent(e)).toThrow();
  });

  test("extra data keys stripped", () => {
    const e = parseEvent({
      ...base,
      type: "session.ended",
      data: { reason: "completed", extra: "junk" },
    });
    expect(e.data).toEqual({ reason: "completed" });
    expect("extra" in e.data).toBe(false);
  });

  test("ts must be ISO-8601", () => {
    const e = (ts: string) => ({ ...base, ts, type: "session.ended", data: { reason: "completed" } });
    expect(() => parseEvent(e("yesterday"))).toThrow();
    expect(() => parseEvent(e("not a date"))).toThrow();
    expect(parseEvent(e("2026-10-08T03:00:00Z")).ts).toBe("2026-10-08T03:00:00Z");
    expect(parseEvent(e("2026-10-08T03:00:00+08:00")).ts).toBe("2026-10-08T03:00:00+08:00");
  });

  test("makeEvent defaults id and ts", () => {
    const e = makeEvent({
      session_id: "s",
      source: { backend: "b" },
      type: "session.ended",
      data: { reason: "completed" },
    });
    expect(e.id).toBeTruthy();
    expect(e.ts).toBeTruthy();
    const e2 = makeEvent({ ...e, ts: undefined });
    expect(e2.id! >= e.id!).toBe(true);
  });

  test("redact paths including wildcard", () => {
    const e = parseEvent({
      ...base,
      type: "turn.user",
      data: {
        turn_id: "t",
        content: [
          { type: "image", mime: "m", data: "SECRET" },
          { type: "text", text: "hello" },
        ],
      },
    });
    const r = redact(e, { paths: ["content.*.data"] });
    const content = (r.data as { content: { data?: string; text?: string }[] }).content;
    expect(content[0]!.data).toBe("[redacted]");
    expect(content[1]!.text).toBe("hello");
    expect(r.id).toBe(e.id);
  });

  test("redact patterns in nested strings", () => {
    const e = parseEvent({
      ...base,
      type: "tool.result",
      data: { call_id: "c", status: "ok", output: "key=AKIA" + "A".repeat(16) + " end" },
    });
    const r = redact(e, { patterns: DEFAULT_SECRET_PATTERNS });
    expect((r.data as { output: string }).output).toBe("key=[redacted] end");
  });

  test("redact does not mutate input", () => {
    const e: Event = parseEvent({
      ...base,
      type: "tool.result",
      data: { call_id: "c", status: "ok", output: "ghp_" + "a".repeat(36) },
    });
    const before = JSON.stringify(e);
    redact(e, { patterns: DEFAULT_SECRET_PATTERNS, paths: ["output"] });
    expect(JSON.stringify(e)).toBe(before);
  });
});
