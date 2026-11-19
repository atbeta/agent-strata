import { LOCALE_TAG, locale, t, type MessageKey } from "./i18n";

/**
 * The schedules panel's own vocabulary.
 *
 * Everything the backend sends about a schedule is a wire value: a weekday
 * is 0-6, a run result is "skipped-busy", a note is English prose. A reader
 * sees words. This file is where the two meet, so the panel component itself
 * only has to draw.
 *
 * It is a plain module and not part of a component because these are the
 * rules worth a test: a weekday that lands on Wednesday and a run result
 * that says the session was busy are both easy to get wrong quietly.
 */

/** The wire shape the plugin sends for one schedule's timing. */
export interface ScheduleWhen {
  kind: string;
  at?: number;
  everyMs?: number;
  hour?: number;
  minute?: number;
  weekday?: number;
}

export interface ScheduleTarget {
  kind: string;
  session_id?: string;
  connection_id?: string;
}

/** One schedule as the panel holds it. */
export interface ScheduleLike {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  when: ScheduleWhen;
  target: ScheduleTarget;
  next_at: string | null;
  last_run_at?: string;
  last_result?: string;
  last_code?: string;
  last_note?: string;
  /** the session's name, when the plugin could resolve one */
  target_title?: string;
}

/** The message key for a weekday number, 0 being Sunday. */
const WEEKDAY_KEYS: MessageKey[] = [
  "schedule.panel.weekday.sunday",
  "schedule.panel.weekday.monday",
  "schedule.panel.weekday.tuesday",
  "schedule.panel.weekday.wednesday",
  "schedule.panel.weekday.thursday",
  "schedule.panel.weekday.friday",
  "schedule.panel.weekday.saturday",
];

/** The weekday a weekly schedule fires on, in the reader's language. */
export function weekdayName(weekday: number | undefined): string {
  const n = Number(weekday);
  if (!Number.isInteger(n) || n < 0 || n > 6) return "";
  return t(WEEKDAY_KEYS[n]!);
}

/** The word for a run result, or "" when the backend sent something new. */
export function runResultText(result: string | undefined): string {
  switch (result) {
    case "ok":
      return t("schedule.panel.result.ok");
    case "skipped-busy":
      return t("schedule.panel.result.skippedBusy");
    case "failed":
      return t("schedule.panel.result.failed");
    case "missed":
      return t("schedule.panel.result.missed");
    case "late":
      return t("schedule.panel.result.late");
    default:
      return "";
  }
}

/** "09:00" from an hour and a minute. */
export function clockText(hour: unknown, minute: unknown): string {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "";
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * A date and time a reader can read: "12月1日 09:00".
 *
 * The format follows the window's language rather than the machine's:
 * a Chinese reader gets "12月1日" and not "Dec 1", because the panel
 * speaks Chinese everywhere else and a month in another language is a
 * foreign word in the middle of a Chinese sentence.
 */
export function dateTimeText(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  const date = new Intl.DateTimeFormat(LOCALE_TAG[locale()], {
    month: "short",
    day: "numeric",
  }).format(d);
  const time = new Intl.DateTimeFormat(LOCALE_TAG[locale()], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${date} ${time}`;
}

/**
 * How far away a moment is, in the reader's language.
 *
 * The unit is chosen by how far away it is — "3 分钟后" while it is still
 * minutes away, "2 小时后" when it is hours — because the number alone never
 * says how long the reader has to wait for something to happen.
 */
export function relativeTimeText(target: number, now: number = Date.now()): string {
  const delta = target - now;
  const abs = Math.abs(delta);
  const sign = delta >= 0 ? "in" : "ago";
  if (abs < 60 * 60 * 1000) {
    const minutes = Math.max(1, Math.round(abs / 60_000));
    return sign === "in"
      ? t("schedule.panel.inMinutes", { minutes: String(minutes) })
      : t("schedule.panel.agoMinutes", { minutes: String(minutes) });
  }
  if (abs < 24 * 60 * 60 * 1000) {
    const hours = Math.max(1, Math.round(abs / (60 * 60 * 1000)));
    return sign === "in"
      ? t("schedule.panel.inHours", { hours: String(hours) })
      : t("schedule.panel.agoHours", { hours: String(hours) });
  }
  const days = Math.max(1, Math.round(abs / (24 * 60 * 60 * 1000)));
  return sign === "in"
    ? t("schedule.panel.inDays", { days: String(days) })
    : t("schedule.panel.agoDays", { days: String(days) });
}

/**
 * The line that says when this schedule runs.
 *
 * A one-shot names its moment; the repeating kinds name their rule. The rule
 * is in the reader's language, not the agent's — the panel holds a weekday
 * number and says "周五".
 */
export function whenText(when: ScheduleWhen): string {
  switch (when.kind) {
    case "daily":
      return t("schedule.panel.dailyAt", { time: clockText(when.hour, when.minute) });
    case "weekly":
      return t("schedule.panel.weeklyAt", {
        weekday: weekdayName(when.weekday),
        time: clockText(when.hour, when.minute),
      });
    case "every": {
      const mins = Math.round(Number(when.everyMs ?? 0) / 60_000);
      return t("schedule.panel.everyMinutes", { minutes: String(mins) });
    }
    case "at":
      return t("schedule.panel.onceAt", { at: dateTimeText(Number(when.at)) });
    default:
      return "";
  }
}

/**
 * Which session the prompt lands in.
 *
 * The reader's question is "where does this go", and a session id answers
 * nothing to a person. The plugin resolves the title where it can; when it
 * cannot, the id is shown so it is still copyable.
 */
export function targetText(row: ScheduleLike, currentSessionId: string): string {
  if (row.target.kind === "new_session") return t("schedule.panel.target.newSession");
  const id = row.target.session_id ?? "";
  if (id === currentSessionId) return t("schedule.panel.target.thisSession");
  if (row.target_title) return row.target_title;
  return id;
}

/**
 * Whether the target line is worth drawing at all.
 *
 * A schedule aimed at the session the reader is looking at says so in
 * one place. Drawing "生效会话" beside "本会话" says the same thing
 * twice, and the reader learns nothing from the second half.
 */
export function showsTargetLine(row: ScheduleLike, currentSessionId: string): boolean {
  return !targetsThisSession(row, currentSessionId);
}

/** Whether the target is the session the reader is looking at. */
export function targetsThisSession(row: ScheduleLike, currentSessionId: string): boolean {
  return row.target.kind === "session" && row.target.session_id === currentSessionId;
}

/**
 * The one-shot's moment as the value a datetime-local input holds.
 *
 * The input speaks "YYYY-MM-DDTHH:mm" in the reader's own wall time, which
 * is what a person picks on a calendar. The backend wants an instant, so
 * the two ends of this conversion are kept apart on purpose.
 */
export function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The instant a datetime-local input's value means.
 *
 * The input's text has no timezone on it, so it is read as the reader's own
 * wall time — which is the moment they picked on the calendar. A naive
 * `new Date(text)` would read it as UTC and shift the fire by the offset.
 */
export function fromLocalInputValue(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const ms = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), 0, 0).getTime();
  return Number.isFinite(ms) ? ms : null;
}
