import { describe, expect, test } from "bun:test";
import type { ScheduleRow } from "./api";
import { nextScheduleRow, scheduleRowsForSession } from "./schedule-summary";

function row(over: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: "sch_1",
    name: "standup",
    prompt: "post the summary",
    created_by: "opencode:creator",
    enabled: true,
    when: { kind: "daily", hour: 9, minute: 0 },
    target: { kind: "session", session_id: "opencode:me" },
    next_at: "2026-11-20T09:00:00.000Z",
    ...over,
  };
}

describe("the current session's schedule summary", () => {
  test("counts tasks aimed at the session, not tasks merely created by it", () => {
    const rows = [
      row(),
      row({ id: "sch_2", target: { kind: "session", session_id: "opencode:other" } }),
      row({ id: "sch_3", target: { kind: "new_session" } }),
    ];
    expect(scheduleRowsForSession(rows, "opencode:me").map((item) => item.id)).toEqual(["sch_1"]);
  });

  test("chooses the nearest enabled run and ignores paused or invalid dates", () => {
    const rows = [
      row({ id: "later", next_at: "2026-11-21T09:00:00.000Z" }),
      row({ id: "paused", enabled: false, next_at: "2026-11-19T09:00:00.000Z" }),
      row({ id: "broken", next_at: "not-a-date" }),
      row({ id: "nearest", next_at: "2026-11-20T08:00:00.000Z" }),
    ];
    expect(nextScheduleRow(rows)?.id).toBe("nearest");
    expect(nextScheduleRow(rows.map((item) => ({ ...item, enabled: false })))).toBeUndefined();
  });
});
