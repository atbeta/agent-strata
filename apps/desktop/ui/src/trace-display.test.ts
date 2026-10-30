import { afterEach, describe, expect, test } from "bun:test";
import { setLocale } from "./i18n";
import {
  TRACE_LANE_PX,
  fmtActive,
  fmtRuler,
  traceBlockTooltip,
  traceFoldLabel,
  traceLaneSlot,
  traceMarkerShape,
} from "./trace-display";
import type { TraceBlock } from "./trace-model";

function block(overrides: Partial<TraceBlock> = {}): TraceBlock {
  return {
    key: "t:c1",
    seq: 2,
    firstSeq: 1,
    ts: new Date(2_500).toISOString(),
    startTs: 1_000,
    endTs: 2_500,
    lane: "tool",
    turn: 2,
    step: 3,
    status: "ok",
    title: "bash",
    preview: "echo hello",
    tone: "bg-primary",
    ...overrides,
  };
}

afterEach(() => setLocale("zh"));

describe("trace marker shapes", () => {
  test("ordinary events are circles and requests are diamonds", () => {
    expect(traceMarkerShape(block({ lane: "event", kind: "file" }))).toBe("circle");
    expect(traceMarkerShape(block({ lane: "event", kind: "permission" }))).toBe("diamond");
    expect(traceMarkerShape(block({ lane: "event", kind: "question" }))).toBe("diamond");
  });

  test("failure and retry semantics take priority over request shape", () => {
    expect(traceMarkerShape(block({ lane: "event", kind: "error", status: "error" }))).toBe("triangle");
    expect(traceMarkerShape(block({ lane: "event", kind: "retry" }))).toBe("triangle");
    expect(
      traceMarkerShape(block({ lane: "event", kind: "permission", status: "error", denied: true })),
    ).toBe("triangle");
    expect(traceMarkerShape(block({ status: "interrupted" }))).toBe("triangle");
  });
});

describe("trace block tooltip", () => {
  test("carries position, title, preview, status, and a real duration", () => {
    setLocale("en");
    const tip = traceBlockTooltip(block());
    expect(tip).toMatchObject({
      position: "Turn 2 · step 3",
      title: "bash",
      preview: "echo hello",
      status: "Completed",
      durationMs: 1_500,
    });
    expect(tip.text).toContain("Turn 2 · step 3");
    expect(tip.text).toContain("bash — echo hello");
    expect(tip.text).toContain("Completed");
    expect(tip.text).toContain("Elapsed: 1.50 s");
  });

  test("an instantaneous input does not invent a zero-millisecond duration", () => {
    setLocale("en");
    const tip = traceBlockTooltip(
      block({ lane: "user", title: "输入", preview: "message", step: undefined, endTs: 1_000 }),
    );
    expect(tip.position).toBe("Turn 2");
    expect(tip.title).toBe("Input");
    expect(tip.preview).toBe("Message");
    expect(tip.durationMs).toBeUndefined();
    expect(tip.text).not.toContain("0 ms");
    expect(tip.text).not.toContain("Elapsed");
  });
});

describe("trace lane slots", () => {
  test("single and concurrent tracks stay inside the taller lane", () => {
    expect(traceLaneSlot(0, 1)).toEqual({ top: 4, height: 12 });
    for (const count of [2, 3]) {
      const slots = Array.from({ length: count }, (_, track) => traceLaneSlot(track, count));
      expect(slots[0]!.top).toBeGreaterThanOrEqual(0);
      for (const slot of slots) {
        expect(slot.height).toBeGreaterThanOrEqual(4);
        expect(slot.top + slot.height).toBeLessThanOrEqual(TRACE_LANE_PX);
      }
      expect(slots[1]!.top).toBeGreaterThanOrEqual(slots[0]!.top + slots[0]!.height);
    }
  });
});

describe("active duration", () => {
  test("a rounded 60 minutes carries into the next hour", () => {
    expect(fmtActive(60 * 60_000 + 59.6 * 60_000)).toBe("2h 00m");
    expect(fmtRuler(60 * 60_000 + 59.6 * 60_000)).toBe("2h00m");
  });
});

describe("trace fold labels", () => {
  test("translate the preserved wall-clock gap", () => {
    expect(traceFoldLabel(240_000)).toBe("折叠 4 m 00 s");
    setLocale("en");
    expect(traceFoldLabel(240_000)).toBe("Folded 4 m 00 s");
  });
});
