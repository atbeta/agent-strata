import { describe, expect, test } from "bun:test";
import type { SessionRow } from "./api";
import {
  cacheEfficiency,
  fleetAttention,
  fleetProjects,
  fleetRecent,
  fleetTotals,
  fleetTrend,
  inPeriod,
  periodStart,
  shareOf,
  tokenParts,
  tokenTotal,
} from "./fleet";

function row(patch: {
  id: string;
  workspace?: string | null;
  last?: string;
  cost?: number;
  input?: number;
  output?: number;
  tools?: number;
  cacheRead?: number;
  cacheWrite?: number;
  busy?: boolean;
  needs_input?: boolean;
}): SessionRow {
  return {
    summary: {
      session_id: patch.id,
      backend: "opencode",
      workspace: patch.workspace ?? null,
      title: patch.id,
      started_at: "2026-10-01T00:00:00.000Z",
      last_ts: patch.last ?? "2026-10-11T00:00:00.000Z",
      last_seq: 1,
    },
    status: "completed",
    busy: patch.busy,
    needs_input: patch.needs_input,
    totals: {
      input: patch.input ?? 0,
      output: patch.output ?? 0,
      cost_usd: patch.cost ?? 0,
      tool_calls: patch.tools ?? 0,
      cache_read: patch.cacheRead ?? 0,
      cache_write: patch.cacheWrite ?? 0,
    },
  };
}

describe("fleet totals", () => {
  test("sums the rows in hand and counts distinct directories", () => {
    const totals = fleetTotals([
      row({ id: "a", workspace: "D:/Code/lector", cost: 1.5, input: 100, output: 40, tools: 3 }),
      row({ id: "b", workspace: "D:/Code/lector", cost: 0.5, input: 10, output: 5, tools: 1 }),
      row({ id: "c", workspace: "D:/Code/notefast", cost: 2, input: 20, output: 20, tools: 2 }),
      row({ id: "d", workspace: "unknown", cost: 0.25, tools: 1 }),
    ]);
    expect(totals.sessions).toBe(4);
    expect(totals.cost).toBeCloseTo(4.25);
    expect(totals.input).toBe(130);
    expect(totals.output).toBe(65);
    expect(totals.tools).toBe(7);
    expect(totals.projects).toBe(3);
  });

  test("keeps the cache columns the previous version dropped", () => {
    const totals = fleetTotals([
      row({ id: "a", input: 10, cacheRead: 900, cacheWrite: 40 }),
      row({ id: "b", input: 10, cacheRead: 100, cacheWrite: 0 }),
    ]);
    expect(totals.cacheRead).toBe(1000);
    expect(totals.cacheWrite).toBe(40);
  });
});

describe("periods", () => {
  const now = new Date(2026, 9, 14, 15, 30, 0).getTime();
  const iso = (day: number, hour = 12) => new Date(2026, 9, day, hour, 0, 0).toISOString();

  test("each window starts where its name says it does", () => {
    expect(periodStart("total", now)).toBe(0);
    expect(periodStart("today", now)).toBe(new Date(2026, 9, 14).getTime());
    expect(periodStart("week", now)).toBe(new Date(2026, 9, 8).getTime());
    expect(periodStart("month", now)).toBe(new Date(2026, 9, 1).getTime());
  });

  test("puts a session in the window its last event falls in", () => {
    const rows = [
      row({ id: "today", last: iso(14) }),
      row({ id: "week", last: iso(9) }),
      row({ id: "month", last: iso(3) }),
      // Last month, and late in the evening so it cannot be a clock slip.
      row({ id: "old", last: new Date(2026, 8, 30, 23, 0, 0).toISOString() }),
    ];
    const ids = (p: Parameters<typeof inPeriod>[1]) => inPeriod(rows, p, now).map((s) => s.summary.session_id);
    expect(ids("today")).toEqual(["today"]);
    expect(ids("week")).toEqual(["today", "week"]);
    expect(ids("month")).toEqual(["today", "week", "month"]);
    expect(ids("total")).toHaveLength(4);
  });

  test("walks the calendar rather than subtracting milliseconds", () => {
    // A week measured in ms lands an hour off across a DST boundary, which
    // would push late-evening sessions into the wrong window.
    const springForward = new Date(2026, 2, 8, 12, 0, 0).getTime();
    const back = new Date(periodStart("week", springForward));
    expect(back.getDate()).toBe(2);
    expect(back.getHours()).toBe(0);
  });
});

describe("token composition", () => {
  test("counts the cache in the total and shares it out", () => {
    const totals = fleetTotals([row({ id: "a", input: 100, output: 50, cacheRead: 800, cacheWrite: 50 })]);
    expect(tokenTotal(totals)).toBe(1000);
    expect(tokenParts(totals)).toEqual([
      { key: "input", value: 100, pct: 10 },
      { key: "output", value: 50, pct: 5 },
      { key: "cacheRead", value: 800, pct: 80 },
      { key: "cacheWrite", value: 50, pct: 5 },
    ]);
  });

  test("leaves out a kind that never happened", () => {
    const parts = tokenParts(fleetTotals([row({ id: "a", input: 30, output: 10 })]));
    expect(parts.map((p) => p.key)).toEqual(["input", "output"]);
    expect(parts.reduce((sum, p) => sum + p.pct, 0)).toBeCloseTo(100);
  });

  test("a window with no usage is empty, not NaN", () => {
    expect(tokenParts(fleetTotals([]))).toEqual([]);
    expect(tokenTotal(fleetTotals([]))).toBe(0);
  });
});

describe("cache efficiency", () => {
  test("is the cached share of everything the model was shown", () => {
    expect(cacheEfficiency(fleetTotals([row({ id: "a", input: 100, cacheRead: 300 })]))).toBe(0.75);
    expect(cacheEfficiency(fleetTotals([row({ id: "a", input: 100 })]))).toBe(0);
    expect(cacheEfficiency(fleetTotals([]))).toBe(0);
  });
});

describe("fleet projects", () => {
  test("groups by directory and puts the heaviest volume first", () => {
    // Tokens lead the sort, not dollars: on a subscription the dollar column is
    // a list price, and ordering the panel by it would rank the wrong projects.
    const projects = fleetProjects([
      row({ id: "a", workspace: "D:/Code/lector", input: 100, cost: 1, last: "2026-10-11T00:00:00.000Z" }),
      row({ id: "b", workspace: "D:/Code/notefast", input: 400, cost: 4, last: "2026-10-09T00:00:00.000Z" }),
      row({ id: "c", workspace: "D:/Code/lector", input: 100, cost: 1, last: "2026-10-12T00:00:00.000Z" }),
    ]);
    expect(projects.map((p) => p.workspace)).toEqual(["D:/Code/notefast", "D:/Code/lector"]);
    expect(projects[1]).toMatchObject({ sessions: 2, cost: 2, tokens: 200, lastTs: "2026-10-12T00:00:00.000Z" });
  });

  test("counts the cache in a project's volume", () => {
    const [only] = fleetProjects([row({ id: "a", input: 10, output: 5, cacheRead: 500, cacheWrite: 1 })]);
    expect(only!.tokens).toBe(516);
  });

  test("falls back to spend only to break a tie on volume", () => {
    const projects = fleetProjects([
      row({ id: "a", workspace: "D:/x", input: 100, cost: 1 }),
      row({ id: "b", workspace: "D:/y", input: 100, cost: 9 }),
    ]);
    expect(projects.map((p) => p.workspace)).toEqual(["D:/y", "D:/x"]);
  });

  test("does not mutate the list it was given", () => {
    const rows = [row({ id: "b", last: "2026-10-02T00:00:00.000Z" }), row({ id: "a", last: "2026-10-03T00:00:00.000Z" })];
    fleetRecent(rows);
    expect(rows.map((s) => s.summary.session_id)).toEqual(["b", "a"]);
    expect(fleetRecent(rows).map((s) => s.summary.session_id)).toEqual(["a", "b"]);
  });
});

describe("fleet attention", () => {
  test("lists sessions waiting on a person ahead of ones still running", () => {
    const ids = fleetAttention([
      row({ id: "run", busy: true, last: "2026-10-12T00:00:00.000Z" }),
      row({ id: "wait-old", needs_input: true, last: "2026-10-01T00:00:00.000Z" }),
      row({ id: "both", busy: true, needs_input: true, last: "2026-10-11T00:00:00.000Z" }),
      row({ id: "done", last: "2026-10-13T00:00:00.000Z" }),
    ]).map((s) => s.summary.session_id);
    expect(ids).toEqual(["both", "wait-old", "run"]);
  });
});

describe("fleet trend", () => {
  const now = new Date(2026, 9, 14, 15, 0, 0).getTime();
  const iso = (day: number) => new Date(2026, 9, day, 12, 0, 0).toISOString();
  // Fourteen columns ending on the 14th reach back to the 1st, so anything
  // older has to leave October altogether to fall off the left edge.
  const beforeWindow = new Date(2026, 8, 20, 12, 0, 0).toISOString();

  test("keeps every day, including the ones with nothing in them", () => {
    const points = fleetTrend(
      [
        row({ id: "today", last: iso(14), cost: 1.5, input: 10, cacheRead: 90 }),
        row({ id: "today-2", last: iso(14), cost: 0.5, input: 10 }),
        row({ id: "too-old", last: beforeWindow, cost: 3 }),
      ],
      now,
      14,
    );
    expect(points).toHaveLength(14);
    expect(points[13]).toMatchObject({ sessions: 2, cost: 2, tokens: 110 });
    expect(points[0]).toMatchObject({ sessions: 0, cost: 0, tokens: 0 });
  });

  test("runs oldest first and stops at today", () => {
    const points = fleetTrend([], now, 14);
    expect(points.map((p) => p.day)).toEqual([...points.map((p) => p.day)].sort((a, b) => a - b));
    expect(points[13]!.day).toBe(new Date(2026, 9, 14).getTime());
  });

  test("a session older than the window is not in any column", () => {
    const points = fleetTrend([row({ id: "old", last: beforeWindow, cost: 9 })], now, 14);
    expect(points.reduce((sum, p) => sum + p.cost, 0)).toBe(0);
  });
});

describe("share", () => {
  test("stays inside 0–100", () => {
    expect(shareOf(0, 10)).toBe(0);
    expect(shareOf(5, 0)).toBe(0);
    expect(shareOf(1, 4)).toBe(25);
    expect(shareOf(8, 4)).toBe(100);
  });
});
