// What a schedule is and when it fires.
//
// The grammar is deliberately small — `at`, `every`, `daily`, `weekly` —
// because a hand-rolled RFC 5545 subset is a bug farm (DST, BY* semantics)
// and these four cover how an agent actually defers work. Local wall time
// for the clock-based kinds: the user reads 09:00 as 09:00 in their zone.

/** Epoch-milliseconds based kinds and wall-clock kinds, one schedule one when. */
export type When =
  | { kind: "at"; at: number }
  | { kind: "every"; everyMs: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };

export type Target =
  | { kind: "session"; session_id: string }
  | { kind: "new_session"; connection_id?: string };

export type RunResult = "ok" | "skipped-busy" | "failed" | "missed" | "late";

export interface Schedule {
  id: string;
  name: string;
  prompt: string;
  /** the casf session that created it — only the owner may update/delete */
  created_by: string;
  created_at: string;
  enabled: boolean;
  when: When;
  target: Target;
  /** computed; null for a finished one-shot */
  next_at: string | null;
  last_run_at?: string;
  last_result?: RunResult;
  last_note?: string;
  /**
   * A stable code for the note above. The note is prose for the log; the
   * code is what a reader's window can show a translated sentence for,
   * the way a service error carries a code beside its message.
   */
  last_code?: string;
  /** whether a missed fire may still run inside the catch-up window (default true) */
  catchup?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

/** "HH:MM" or "H:MM" → wall-clock time, or a readable error. */
export function parseClock(text: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) throw new Error(`expected HH:MM, got ${JSON.stringify(text)}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`${text} is not a time of day`);
  return { hour, minute };
}

/** "fri 18:00" / "friday 18:00" → a weekly when. */
export function parseWeekly(text: string): { weekday: number; hour: number; minute: number } {
  const m = /^([a-z]+)\s+(.+)$/i.exec(text.trim());
  if (!m) throw new Error(`expected "<weekday> HH:MM", got ${JSON.stringify(text)}`);
  const weekday = WEEKDAYS[m[1]!.toLowerCase()];
  if (weekday === undefined) throw new Error(`${m[1]} is not a weekday`);
  return { weekday, ...parseClock(m[2]!) };
}

/**
 * The next wall-clock occurrence strictly after `after` (a local-time Date
 * read). `at` and `every` kinds do not come through here — their next is
 * arithmetic on next_at, done by the engine.
 */
export function nextClockAt(when: When, after: Date): number | null {
  if (when.kind !== "daily" && when.kind !== "weekly") return null;
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  if (when.kind === "daily") {
    d.setHours(when.hour, when.minute, 0, 0);
    if (d.getTime() <= after.getTime()) d.setTime(d.getTime() + DAY_MS);
    return d.getTime();
  }
  const delta = (when.weekday - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + delta);
  d.setHours(when.hour, when.minute, 0, 0);
  if (d.getTime() <= after.getTime()) d.setDate(d.getDate() + 7);
  return d.getTime();
}

/** First fire time for a freshly created schedule. */
export function firstAt(when: When, now: number): number | null {
  switch (when.kind) {
    case "at":
      return when.at;
    case "every":
      return now + when.everyMs;
    default:
      return nextClockAt(when, new Date(now));
  }
}

/** The fire after `prev` for a repeating schedule; skips missed beats. */
export function followingAt(when: When, now: number): number | null {
  switch (when.kind) {
    case "at":
      return null;
    case "every":
      return now + when.everyMs;
    default:
      return nextClockAt(when, new Date(now));
  }
}

/** One readable line for list output. */
export function describeWhen(when: When): string {
  switch (when.kind) {
    case "at":
      return `once at ${new Date(when.at).toISOString()}`;
    case "every": {
      const mins = when.everyMs / 60000;
      return mins % 60 === 0 ? `every ${mins / 60}h` : `every ${mins}m`;
    }
    case "daily":
      return `daily ${String(when.hour).padStart(2, "0")}:${String(when.minute).padStart(2, "0")}`;
    case "weekly": {
      const day = Object.keys(WEEKDAYS).find((k) => k.length === 3 && WEEKDAYS[k] === when.weekday) ?? "?";
      return `${day} ${String(when.hour).padStart(2, "0")}:${String(when.minute).padStart(2, "0")}`;
    }
  }
}
