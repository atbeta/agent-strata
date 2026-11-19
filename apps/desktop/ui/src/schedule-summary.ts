import type { ScheduleRow } from "./api";

export function scheduleRowsForSession(
  rows: readonly ScheduleRow[],
  sessionId: string,
): ScheduleRow[] {
  return rows.filter(
    (row) => row.target.kind === "session" && row.target.session_id === sessionId,
  );
}

export function nextScheduleRow(rows: readonly ScheduleRow[]): ScheduleRow | undefined {
  return rows
    .filter((row) => row.enabled && Number.isFinite(Date.parse(row.next_at ?? "")))
    .sort((left, right) => Date.parse(left.next_at!) - Date.parse(right.next_at!))[0];
}
