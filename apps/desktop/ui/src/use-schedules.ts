import { createEffect, createMemo, createResource, onCleanup } from "solid-js";
import { listSchedules, type ScheduleCandidate, type ScheduleRow } from "./api";
import { t } from "./i18n";
import { settled } from "./resource";
import { scheduleFacts } from "./schedule-format";
import { nextScheduleRow, scheduleRowsForSession } from "./schedule-summary";

export type SchedulesController = ReturnType<typeof useSchedules>;

export function useSchedules(sessionId: () => string, enabled: () => boolean = () => true) {
  const [data, { refetch }] = createResource(
    () => (enabled() ? sessionId() : undefined),
    (id) => listSchedules(id),
  );
  // Read through `settled`: the route is `/plugins/schedule/...`, which answers
  // 404 when the schedule plugin is not running. A bare read throws, and the
  // throw unmounts the session page into "无法连接到本地服务" over what is
  // really "this session has no schedules". `loadState` below still reports the
  // failure to the panel that wants to show it.
  const rows = createMemo<ScheduleRow[]>(() => settled(data)?.schedules ?? []);
  const candidates = createMemo<ScheduleCandidate[]>(() => settled(data)?.candidates ?? []);
  const loadState = (): "loading" | "ready" | "error" => {
    if (settled(data) !== undefined) return "ready";
    if (data.error) return "error";
    return "loading";
  };
  const error = () => {
    const value = data.error;
    return value ? (value instanceof Error ? value.message : String(value)) : undefined;
  };
  const current = createMemo(() => scheduleRowsForSession(rows(), sessionId()));
  const count = createMemo(() => current().length);
  const names = createMemo(() => current().map((row) => row.name));
  const upcoming = createMemo(() => nextScheduleRow(current()));
  const next = () => {
    const row = upcoming();
    if (row) return scheduleFacts(row, sessionId()).next;
    return count() > 0 ? t("schedule.panel.noUpcoming") : "";
  };
  const reload = () => {
    void refetch();
  };

  createEffect(() => {
    if (!enabled()) return;
    sessionId();
    const timer = setInterval(reload, 5_000);
    onCleanup(() => clearInterval(timer));
  });

  return { rows, candidates, loadState, error, current, count, names, next, reload };
}
