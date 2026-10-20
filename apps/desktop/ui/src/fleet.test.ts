import { describe, expect, test } from "bun:test";
import type { DailyUsageRow, SessionRow } from "./api";
import {
  cacheEfficiency,
  dayKey,
  fleetAttention,
  fleetModels,
  fleetProjects,
  fleetRecent,
  fleetStatus,
  fleetTotals,
  fleetTrend,
  fmtShare,
  inPeriod,
  periodKeys,
  periodStart,
  sessionPeriodTotals,
  shareOf,
  tokenParts,
  tokenTotal,
} from "./fleet";

function row(patch: {
  id: string;
  workspace?: string | null;
  last?: string;
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
      input: 0,
      output: 0,
      cost_usd: 0,
      tool_calls: 0,
      cache_read: 0,
      cache_write: 0,
    },
  };
}

function bucket(patch: Partial<DailyUsageRow> & { session_id: string; day: string }): DailyUsageRow {
  return {
    model: null,
    input: 0,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_write: 0,
    cost_usd: 0,
    messages: 0,
    tool_calls: 0,
    tool_errors: 0,
    ...patch,
  };
}

const NOW = new Date(2026, 9, 14, 15, 30, 0).getTime(); // Oct 14
const key = (day: number, month = 9) => `2026-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const iso = (day: number, hour = 12) => new Date(2026, 9, day, hour, 0, 0).toISOString();

describe("day keys and windows", () => {
  test("dayKey is the local calendar date", () => {
    expect(dayKey(NOW)).toBe("2026-10-14");
    expect(dayKey(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
  });

  test("each window admits the days its name says", () => {
    const today = periodKeys("today", NOW);
    expect(today("2026-10-14")).toBe(true);
    expect(today("2026-10-13")).toBe(false);

    const week = periodKeys("week", NOW);
    expect(week("2026-10-08")).toBe(true);
    expect(week("2026-10-07")).toBe(false);
    expect(week("2026-10-14")).toBe(true);

    const month = periodKeys("month", NOW);
    expect(month("2026-10-01")).toBe(true);
    expect(month("2026-09-30")).toBe(false);

    expect(periodKeys("total", NOW)("1999-01-01")).toBe(true);
  });

  test("a month-start window covers the whole month, not a day", () => {
    const first = new Date(2026, 9, 1, 0, 30, 0).getTime();
    const month = periodKeys("month", first);
    expect(month("2026-10-01")).toBe(true);
    expect(month("2026-10-31")).toBe(true);
    expect(month("2026-09-30")).toBe(false);
  });

  test("periodStart still walks the calendar rather than subtracting ms", () => {
    expect(periodStart("total", NOW)).toBe(0);
    expect(periodStart("today", NOW)).toBe(new Date(2026, 9, 14).getTime());
    expect(periodStart("week", NOW)).toBe(new Date(2026, 9, 8).getTime());
    expect(periodStart("month", NOW)).toBe(new Date(2026, 9, 1).getTime());
    const springForward = new Date(2026, 2, 8, 12, 0, 0).getTime();
    const back = new Date(periodStart("week", springForward));
    expect(back.getDate()).toBe(2);
    expect(back.getHours()).toBe(0);
  });
});

describe("period scope", () => {
  const rows = [
    row({ id: "a", last: iso(14) }),
    row({ id: "b", last: iso(9) }),
    row({ id: "c", last: iso(3) }),
    row({ id: "d", last: new Date(2026, 8, 30, 23, 0, 0).toISOString() }),
  ];
  const buckets = [
    bucket({ session_id: "a", day: key(14), input: 10 }),
    // A long-running session's usage lands on the day it happened, not where
    // its last event was.
    bucket({ session_id: "b", day: key(2), input: 10 }),
    bucket({ session_id: "b", day: key(9), input: 10 }),
  ];

  test("a session is in a window when a bucket lands there", () => {
    const ids = (p: Parameters<typeof inPeriod>[2]) =>
      inPeriod(rows, buckets, p, NOW).map((s) => s.summary.session_id);
    expect(ids("today")).toEqual(["a"]);
    expect(ids("week")).toEqual(["a", "b"]);
    // b has an October bucket even though its last event is inside the week.
    expect(ids("month")).toEqual(["a", "b", "c"]);
    expect(ids("total")).toHaveLength(4);
  });

  test("a fresh session with no usage still counts on last_ts", () => {
    const fresh = row({ id: "fresh", last: iso(14, 15) });
    expect(
      inPeriod([fresh], [], "today", NOW).map((s) => s.summary.session_id),
    ).toEqual(["fresh"]);
  });

  test("buckets of sessions outside the list do not count", () => {
    const totals = fleetTotals(
      rows,
      [...buckets, bucket({ session_id: "not-listed", day: key(14), input: 999, cost_usd: 9 })],
      "today",
      NOW,
    );
    expect(totals.input).toBe(10);
    expect(totals.cost).toBe(0);
  });
});

describe("fleet totals", () => {
  test("sums the in-window buckets and counts the union's directories", () => {
    const rows = [
      row({ id: "a", workspace: "D:/Code/lector", last: iso(14) }),
      row({ id: "b", workspace: "D:/Code/lector", last: iso(14) }),
      row({ id: "c", workspace: "D:/Code/notefast", last: iso(1) }),
      row({ id: "fresh", workspace: "unknown", last: iso(14, 15) }),
    ];
    const buckets = [
      bucket({ session_id: "a", day: key(14), input: 100, output: 40, cost_usd: 1.5, tool_calls: 3, tool_errors: 1 }),
      bucket({ session_id: "b", day: key(14), input: 10, output: 5, reasoning: 2, cost_usd: 0.5, tool_calls: 1 }),
      bucket({ session_id: "b", day: key(1), input: 999, cost_usd: 9 }),
      bucket({ session_id: "c", day: key(1), input: 20 }),
    ];
    const totals = fleetTotals(rows, buckets, "today", NOW);
    expect(totals.sessions).toBe(3); // a, b, and the fresh one on last_ts
    expect(totals.cost).toBeCloseTo(2);
    expect(totals.input).toBe(110);
    expect(totals.output).toBe(45);
    expect(totals.reasoning).toBe(2);
    expect(totals.tools).toBe(4);
    expect(totals.toolErrors).toBe(1);
    expect(totals.projects).toBe(2); // lector + unknown
  });
});

describe("token composition", () => {
  const totals = (buckets: DailyUsageRow[]) =>
    fleetTotals([row({ id: "a" })], buckets, "total", NOW);

  test("counts the cache and reasoning in the total and shares them out", () => {
    const t = totals([
      bucket({ session_id: "a", day: key(10), input: 100, output: 50, reasoning: 25, cache_read: 800, cache_write: 25 }),
    ]);
    expect(tokenTotal(t)).toBe(1000);
    expect(tokenParts(t)).toEqual([
      { key: "input", value: 100, pct: 10 },
      { key: "cacheRead", value: 800, pct: 80 },
      { key: "cacheWrite", value: 25, pct: 2.5 },
      { key: "output", value: 50, pct: 5 },
      { key: "reasoning", value: 25, pct: 2.5 },
    ]);
  });

  test("leaves out a kind that never happened", () => {
    const parts = tokenParts(totals([bucket({ session_id: "a", day: key(10), input: 30, output: 10 })]));
    expect(parts.map((p) => p.key)).toEqual(["input", "output"]);
    expect(parts.reduce((sum, p) => sum + p.pct, 0)).toBeCloseTo(100);
  });

  test("a window with no usage is empty, not NaN", () => {
    expect(tokenParts(totals([]))).toEqual([]);
    expect(tokenTotal(totals([]))).toBe(0);
  });
});

describe("cache efficiency", () => {
  const totals = (buckets: DailyUsageRow[]) =>
    fleetTotals([row({ id: "a" })], buckets, "total", NOW);

  test("is the cached share of everything the prompt carried", () => {
    expect(
      cacheEfficiency(
        totals([bucket({ session_id: "a", day: key(10), input: 100, cache_read: 300 })]),
      ),
    ).toBe(0.75);
    expect(cacheEfficiency(totals([bucket({ session_id: "a", day: key(10), input: 100 })]))).toBe(0);
    expect(cacheEfficiency(totals([]))).toBe(0);
  });

  test("cache writes count in the prompt side too", () => {
    // input 100 + read 300 + write 100 = 500 sent; 300 of it was a hit.
    expect(
      cacheEfficiency(
        totals([
          bucket({ session_id: "a", day: key(10), input: 100, cache_read: 300, cache_write: 100 }),
        ]),
      ),
    ).toBe(0.6);
  });
});

describe("fleet projects", () => {
  test("groups by directory on the window's own tokens", () => {
    const rows = [
      row({ id: "a", workspace: "D:/Code/lector", last: iso(14) }),
      row({ id: "b", workspace: "D:/Code/notefast", last: iso(14) }),
      row({ id: "c", workspace: "D:/Code/lector", last: iso(14) }),
    ];
    const buckets = [
      bucket({ session_id: "a", day: key(14), input: 100, cost_usd: 1 }),
      // c's lifetime is large but its in-window share is small.
      bucket({ session_id: "c", day: key(14), input: 50 }),
      bucket({ session_id: "c", day: key(1), input: 10_000 }),
      bucket({ session_id: "b", day: key(14), input: 400, cost_usd: 4 }),
    ];
    const projects = fleetProjects(rows, buckets, "week", NOW);
    expect(projects.map((p) => p.workspace)).toEqual(["D:/Code/notefast", "D:/Code/lector"]);
    expect(projects[1]).toMatchObject({ sessions: 2, cost: 1, tokens: 150 });
  });

  test("a session that was active but spent nothing still sits on its row", () => {
    const projects = fleetProjects(
      [row({ id: "a", workspace: "D:/x", last: iso(14) })],
      [],
      "week",
      NOW,
    );
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ sessions: 1, tokens: 0 });
  });
});

describe("fleet recent", () => {
  test("scopes to the window and sorts newest first without mutating", () => {
    const rows = [
      row({ id: "old", last: iso(2) }),
      row({ id: "b", last: iso(9) }),
      row({ id: "a", last: iso(14) }),
    ];
    const buckets = [
      bucket({ session_id: "a", day: key(14), input: 10 }),
      bucket({ session_id: "b", day: key(9), input: 10 }),
      bucket({ session_id: "old", day: key(2), input: 10 }),
    ];
    const recent = fleetRecent(rows, buckets, "week", NOW).map((s) => s.summary.session_id);
    expect(recent).toEqual(["a", "b"]);
    expect(rows.map((s) => s.summary.session_id)).toEqual(["old", "b", "a"]);
  });
});

describe("session period totals", () => {
  test("sums a session's own in-window buckets", () => {
    const map = sessionPeriodTotals(
      [row({ id: "a" })],
      [
        bucket({ session_id: "a", day: key(14), input: 10, output: 5, reasoning: 1, cache_read: 3, cache_write: 1, cost_usd: 0.5 }),
        bucket({ session_id: "a", day: key(1), input: 999 }),
      ],
      "week",
      NOW,
    );
    expect(map.get("a")).toEqual({ tokens: 20, cost: 0.5, model: null });
  });

  test("names the session's heaviest in-window model, null when none", () => {
    const map = sessionPeriodTotals(
      [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })],
      [
        bucket({ session_id: "a", day: key(14), model: "p/big", input: 100 }),
        bucket({ session_id: "a", day: key(14), model: "p/small", input: 10 }),
        bucket({ session_id: "a", day: key(1), model: "p/other", input: 9999 }),
        // Unnamed work only — the row is still that session's, just untitled.
        bucket({ session_id: "b", day: key(14), model: null, input: 10 }),
        // A tools-only bucket names no model.
        bucket({ session_id: "c", day: key(14), tool_calls: 2 }),
      ],
      "week",
      NOW,
    );
    expect(map.get("a")!.model).toBe("p/big");
    expect(map.get("b")!.model).toBeNull();
    expect(map.get("c")!.model).toBeNull();
  });
});

describe("fleet status", () => {
  test("splits waiting from running, both newest first", () => {
    const status = fleetStatus([
      row({ id: "run-old", busy: true, last: "2026-10-10T00:00:00.000Z" }),
      row({ id: "wait", needs_input: true, last: "2026-10-01T00:00:00.000Z" }),
      row({ id: "both", busy: true, needs_input: true, last: "2026-10-13T00:00:00.000Z" }),
      row({ id: "run", busy: true, last: "2026-10-12T00:00:00.000Z" }),
      row({ id: "done", last: "2026-10-14T00:00:00.000Z" }),
    ]);
    expect(status.waiting.map((s) => s.summary.session_id)).toEqual(["both", "wait"]);
    expect(status.running.map((s) => s.summary.session_id)).toEqual(["run", "run-old"]);
  });
});

describe("fleet models", () => {
  test("ranks models by in-window tokens, unnamed last row included", () => {
    const models = fleetModels(
      [row({ id: "a" }), row({ id: "b" })],
      [
        bucket({ session_id: "a", day: key(14), model: "p/big", input: 400, cost_usd: 2 }),
        bucket({ session_id: "a", day: key(14), model: "p/small", input: 90 }),
        bucket({ session_id: "b", day: key(14), model: "p/small", input: 20, cache_read: 90 }),
        bucket({ session_id: "a", day: key(14), model: null, tool_calls: 5 }),
        bucket({ session_id: "a", day: key(1), model: "p/big", input: 999 }),
        bucket({ session_id: "not-listed", day: key(14), model: "p/other", input: 999 }),
      ],
      "week",
      NOW,
    );
    expect(models.map((m) => m.model)).toEqual(["p/big", "p/small"]);
    expect(models[0]).toMatchObject({ tokens: 400, cost: 2, sessions: 1 });
    expect(models[1]).toMatchObject({ tokens: 200, sessions: 2 });
  });

  test("a model with no in-window tokens is not a row", () => {
    expect(
      fleetModels(
        [row({ id: "a" })],
        [bucket({ session_id: "a", day: key(14), model: "p/x", tool_calls: 3 })],
        "week",
        NOW,
      ),
    ).toEqual([]);
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
  const trendNow = new Date(2026, 9, 14, 15, 0, 0).getTime();
  const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "gone" })];

  test("places each bucket on its own day and counts distinct sessions", () => {
    const points = fleetTrend(
      rows,
      [
        bucket({ session_id: "a", day: key(14), input: 10, cache_read: 90, cost_usd: 1.5 }),
        bucket({ session_id: "a", day: key(1), input: 5 }),
        bucket({ session_id: "b", day: key(14), input: 10, cost_usd: 0.5 }),
        // A session outside the page's list is not this chart's business.
        bucket({ session_id: "not-listed", day: key(14), input: 7 }),
        bucket({ session_id: "a", day: "2026-09-20", input: 9 }),
      ],
      trendNow,
      14,
    );
    expect(points).toHaveLength(14);
    expect(points[13]).toMatchObject({ sessions: 2, cost: 2, tokens: 110 });
    expect(points[0]).toMatchObject({ sessions: 1, tokens: 5 });
    expect(points[1]).toMatchObject({ sessions: 0, tokens: 0 });
  });

  test("runs oldest first and stops at today", () => {
    const points = fleetTrend([], [], trendNow, 14);
    expect(points.map((p) => p.day)).toEqual([...points.map((p) => p.day)].sort((a, b) => a - b));
    expect(points[13]!.day).toBe(new Date(2026, 9, 14).getTime());
    expect(points[13]!.label).toBeTruthy();
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

describe("fmtShare", () => {
  test("keeps small shares readable instead of rounding them away", () => {
    expect(fmtShare(0)).toBe("0%");
    expect(fmtShare(0.05)).toBe("<0.1%");
    expect(fmtShare(3.36)).toBe("3.4%");
    expect(fmtShare(9.96)).toBe("10%");
    expect(fmtShare(73.4)).toBe("73%");
  });
});
