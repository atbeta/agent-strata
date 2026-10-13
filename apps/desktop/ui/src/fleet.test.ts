import { describe, expect, test } from "bun:test";
import type { SessionRow } from "./api";
import {
  dayBucket,
  fleetActivity,
  fleetAttention,
  fleetProjects,
  fleetRecent,
  fleetTotals,
  shareOf,
} from "./fleet";

function row(patch: {
  id: string;
  workspace?: string | null;
  last?: string;
  cost?: number;
  input?: number;
  output?: number;
  tools?: number;
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
      cache_read: 0,
      cache_write: 0,
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
});

describe("fleet projects", () => {
  test("groups by directory and puts the heaviest spend first", () => {
    const projects = fleetProjects([
      row({ id: "a", workspace: "D:/Code/lector", cost: 1, last: "2026-10-11T00:00:00.000Z" }),
      row({ id: "b", workspace: "D:/Code/notefast", cost: 4, last: "2026-10-09T00:00:00.000Z" }),
      row({ id: "c", workspace: "D:/Code/lector", cost: 1, last: "2026-10-12T00:00:00.000Z" }),
    ]);
    expect(projects.map((p) => p.workspace)).toEqual(["D:/Code/notefast", "D:/Code/lector"]);
    expect(projects[1]).toMatchObject({ sessions: 2, cost: 2, lastTs: "2026-10-12T00:00:00.000Z" });
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

describe("fleet activity", () => {
  test("keeps every bucket, including the ones with nothing in them", () => {
    const now = new Date(2026, 9, 14, 15, 0, 0).getTime();
    const iso = (day: number) => new Date(2026, 9, day, 12, 0, 0).toISOString();
    expect(dayBucket(iso(14), now)).toBe("time.today");
    expect(dayBucket(iso(13), now)).toBe("time.yesterday");
    expect(dayBucket(iso(10), now)).toBe("time.week");
    expect(dayBucket(iso(1), now)).toBe("time.older");

    const activity = fleetActivity(
      [
        row({ id: "today", last: iso(14), cost: 1.5 }),
        row({ id: "today-2", last: iso(14), cost: 0.5 }),
        row({ id: "old", last: iso(1), cost: 3 }),
      ],
      now,
    );
    expect(activity.map((b) => [b.key, b.sessions, b.cost])).toEqual([
      ["time.today", 2, 2],
      ["time.yesterday", 0, 0],
      ["time.week", 0, 0],
      ["time.older", 1, 3],
    ]);
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
