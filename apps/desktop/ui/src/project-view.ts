import { dayKey, periodKeys } from "./fleet";
import { date, t } from "./i18n";

/**
 * The lens on the project section: what the reader is looking at, and how the
 * list under it is cut up.
 *
 * A lens is window-side, like a pin: it says what this window shows, not what
 * the backend holds. So it lives in storage here rather than on the service,
 * and it survives a restart — a reader who keeps the list down to the projects
 * they work in wants that on the next open. Unlike a fold, a lens hides
 * nothing that was there to be found: what it leaves out is what the reader
 * asked to leave out.
 */

/** How the list under the header is cut up. */
export type GroupBy = "project" | "day";

/** Which sessions a group shows. */
export type StatusLens = "all" | "busy" | "waiting" | "idle";

/** How far back to look. */
export type PeriodLens = "all" | "today" | "week" | "month";

export type ProjectLens = {
  /** the text the reader typed — a project's name or path has to contain it */
  query: string;
  /** leave out the projects that hold no session */
  hideEmpty: boolean;
  /** by the place a session lives, or by the day it last ran */
  groupBy: GroupBy;
  /** which sessions come through */
  status: StatusLens;
  /** how far back to look */
  period: PeriodLens;
  /** the backend a session came from; "" is every backend */
  type: string;
};

export const LENS_KEY = "strata.projectLens.v2";

/**
 * The first lens had a query and an empty switch and nothing else. Its reader
 * keeps them; the categories that came later are set to their defaults.
 */
const LEGACY_LENS_KEY = "strata.projectLens.v1";

export const NO_LENS: ProjectLens = {
  query: "",
  hideEmpty: false,
  groupBy: "project",
  status: "all",
  period: "all",
  type: "",
};

function statusOf(value: unknown): StatusLens {
  return value === "busy" || value === "waiting" || value === "idle" ? value : "all";
}

function periodOf(value: unknown): PeriodLens {
  return value === "today" || value === "week" || value === "month" ? value : "all";
}

/**
 * A stored lens, read defensively.
 *
 * One unreadable field does not throw the rest of the lens away: a reader who
 * asked for today's sessions should still get them after a version bump
 * garbles the field next to it. A record that is not a lens at all is no lens.
 */
function parseLens(raw: string | null): ProjectLens | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const rec = parsed as Record<string, unknown>;
  return {
    query: typeof rec.query === "string" ? rec.query : "",
    hideEmpty: rec.hideEmpty === true,
    groupBy: rec.groupBy === "day" ? "day" : "project",
    status: statusOf(rec.status),
    period: periodOf(rec.period),
    type: typeof rec.type === "string" ? rec.type : "",
  };
}

export function readLens(storage: Pick<Storage, "getItem"> = localStorage): ProjectLens {
  const current = parseLens(storage.getItem(LENS_KEY));
  if (current) return current;
  const legacy = parseLens(storage.getItem(LEGACY_LENS_KEY));
  return legacy ?? NO_LENS;
}

export function writeLens(lens: ProjectLens, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(LENS_KEY, JSON.stringify(lens));
  } catch {
    // Private mode can refuse storage; the lens simply does not persist.
  }
}

/** A session, as the lens looks at it. */
export type LensSession = {
  title?: string | null;
  backend: string;
  lastTs: string;
  busy?: boolean;
  needsInput?: boolean;
};

/** A project, as the lens looks at it. */
export type LensProject = {
  /** the name on the group header */
  label: string;
  /** the whole path — it carries the name and the parents around it */
  path: string;
  /** how many sessions it holds */
  count: number;
};

/**
 * Does this session answer the lens?
 *
 * The name is a query over what the reader can see: a project's name, its
 * path, or the session's own title. A project named by the query keeps every
 * session in it — the reader asked for that project, not for one of its rows.
 */
export function sessionVisible(
  lens: ProjectLens,
  session: LensSession,
  project: { label: string; path: string },
  now: number,
): boolean {
  if (lens.type && session.backend !== lens.type) return false;

  if (lens.status === "busy" && !(session.busy && !session.needsInput)) return false;
  if (lens.status === "waiting" && !session.needsInput) return false;
  if (lens.status === "idle" && (session.busy || session.needsInput)) return false;

  if (lens.period !== "all") {
    const ts = new Date(session.lastTs).getTime();
    if (!Number.isFinite(ts)) return false;
    if (!periodKeys(lens.period, now)(dayKey(ts))) return false;
  }

  const q = lens.query.trim().toLowerCase();
  if (!q) return true;
  if ((session.title ?? "").toLowerCase().includes(q)) return true;
  return project.label.toLowerCase().includes(q) || project.path.toLowerCase().includes(q);
}

/**
 * Does this group survive the lens?
 *
 * A group with rows left is in. A group with none left is out: an empty
 * header under a list is noise, whatever emptied it. The one exception is a
 * project that never held a session — it is a place work can start, so it
 * stays unless the reader asks for the empty ones to go, and it stays when it
 * is the place they are standing in.
 */
export function groupVisible(
  lens: ProjectLens,
  group: { rows: number; total: number; path: string },
  keep?: string,
): boolean {
  if (group.rows > 0) return true;
  if (group.total > 0) return false;
  if (keep && group.path === keep) return true;
  return !lens.hideEmpty;
}

/**
 * How many axes are off their resting value.
 *
 * Zero is the lens doing nothing. The button that opens it wears the count
 * when it is not: a colour shift on a mark this small is easy to miss once
 * the menu has closed, and a digit is something a reader can check without
 * opening the menu to find out whether the list is the whole list.
 */
export function lensCount(lens: ProjectLens): number {
  let n = 0;
  if (lens.query.trim().length > 0) n += 1;
  if (lens.hideEmpty) n += 1;
  if (lens.groupBy !== NO_LENS.groupBy) n += 1;
  if (lens.status !== NO_LENS.status) n += 1;
  if (lens.period !== NO_LENS.period) n += 1;
  if (lens.type !== NO_LENS.type) n += 1;
  return n;
}

/** Whether the lens is narrowing anything at all. */
export function lensActive(lens: ProjectLens): boolean {
  return lensCount(lens) > 0;
}

/**
 * The backends the list actually holds.
 *
 * The type menu offers what is there and nothing else: a reader who has only
 * ever run OpenCode is not shown a choice they cannot take.
 */
export function lensTypes(backends: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const b of backends) if (b) out.add(b);
  return [...out].sort();
}

/**
 * The name on a day group: today, yesterday, or the date.
 *
 * The two days a reader says out loud get said out loud; the rest are dates,
 * because "10/11" is what a reader looks for when they are hunting for
 * something that happened a while ago.
 */
export function dayLabel(day: string, now: number): string {
  if (day === dayKey(now)) return t("time.today");
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === dayKey(yesterday.getTime())) return t("time.yesterday");
  return date(new Date(`${day}T00:00:00`).getTime());
}
