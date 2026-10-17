import { realWorkspace, type SessionRow } from "./api";
import { date, t } from "./i18n";

/**
 * Short relative label for a session's last event.
 *
 * Shared by the sidebar rows and the overview, so "10/11" in one place and
 * "3h" in the other cannot drift apart.
 */
export function relTime(iso: string, now = Date.now()): string {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "";
  const mins = Math.round((now - ts) / 60_000);
  if (mins < 1) return t("time.now");
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 36) return `${hours}h`;
  return date(ts);
}

/** The directory's own name. A root path has no last segment worth showing. */
export function projectName(path: string): string {
  if (path === "/" || path === "\\") return t("project.root");
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/**
 * The windows the overview can be read through.
 *
 * `total` is last on purpose: it is the default, so the switcher opens on the
 * window the sidebar is already showing, and reaching a narrower one is the
 * deliberate act.
 */
export const PERIODS = ["today", "week", "month", "total"] as const;
export type Period = (typeof PERIODS)[number];

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The first instant of a period, or 0 for `total`.
 *
 * Built by walking the calendar rather than by subtracting milliseconds: six
 * days back is not six days on a clock that moved, so a DST week would drop an
 * hour of the evening and put yesterday's last session into today.
 */
export function periodStart(period: Period, now: number): number {
  if (period === "total") return 0;
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  if (period === "today") return d.getTime();
  if (period === "week") {
    d.setDate(d.getDate() - 6);
    return d.getTime();
  }
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/** The rows touched inside a period. A session is placed by its last event. */
export function inPeriod(rows: SessionRow[], period: Period, now: number): SessionRow[] {
  if (period === "total") return rows;
  const since = periodStart(period, now);
  return rows.filter((s) => {
    const ts = new Date(s.summary.last_ts).getTime();
    return Number.isFinite(ts) && ts >= since;
  });
}

export type FleetTotals = {
  sessions: number;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tools: number;
  projects: number;
};

export function fleetTotals(rows: SessionRow[]): FleetTotals {
  const projects = new Set<string>();
  let cost = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let tools = 0;
  for (const s of rows) {
    cost += s.totals.cost_usd;
    input += s.totals.input;
    output += s.totals.output;
    cacheRead += s.totals.cache_read;
    cacheWrite += s.totals.cache_write;
    tools += s.totals.tool_calls;
    projects.add(realWorkspace(s.workspace ?? s.summary.workspace) ?? "");
  }
  return {
    sessions: rows.length,
    cost,
    input,
    output,
    cacheRead,
    cacheWrite,
    tools,
    projects: projects.size,
  };
}

/**
 * The token total, counting the cache alongside the prompt and the completion.
 *
 * Cache reads are tokens the provider served for free, so leaving them out of
 * the headline understates the volume by the largest single share of it. The
 * cost figure is unaffected — that is what the composition bar is for: it shows
 * the reader which part of the traffic was billed as prompt, which part was
 * billed as completion, and which part was billed nothing.
 */
export function tokenTotal(totals: FleetTotals): number {
  return totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
}

export type TokenKey = "input" | "output" | "cacheRead" | "cacheWrite";

export type TokenPart = { key: TokenKey; value: number; pct: number };

const TOKEN_ORDER: TokenKey[] = ["input", "output", "cacheRead", "cacheWrite"];

/** Only the kinds that actually occurred, largest share first is not applied — the order is the reading order. */
export function tokenParts(totals: FleetTotals): TokenPart[] {
  const total = tokenTotal(totals);
  return TOKEN_ORDER.filter((key) => valueOf(totals, key) > 0).map((key) => ({
    key,
    value: valueOf(totals, key),
    pct: total > 0 ? (valueOf(totals, key) / total) * 100 : 0,
  }));
}

function valueOf(totals: FleetTotals, key: TokenKey): number {
  return key === "cacheRead" ? totals.cacheRead : key === "cacheWrite" ? totals.cacheWrite : totals[key];
}

/**
 * How much of the prompt traffic was served from cache.
 *
 * Cache reads count toward the same budget as uncached input, so this is the
 * share of what the model was shown that it had already seen. Without a cache
 * there is nothing to be efficient about and the answer is zero, not a gap in
 * the page.
 */
export function cacheEfficiency(totals: FleetTotals): number {
  const whole = totals.cacheRead + totals.input;
  return whole > 0 ? totals.cacheRead / whole : 0;
}

export type ProjectRollup = {
  workspace?: string;
  sessions: number;
  cost: number;
  tokens: number;
  lastTs: string;
};

/** One row per directory, heaviest spend first. A missing workspace shares a row. */
export function fleetProjects(rows: SessionRow[]): ProjectRollup[] {
  const map = new Map<string, ProjectRollup>();
  for (const s of rows) {
    const workspace = realWorkspace(s.workspace ?? s.summary.workspace);
    const key = workspace ?? "";
    const cur = map.get(key) ?? {
      workspace,
      sessions: 0,
      cost: 0,
      tokens: 0,
      lastTs: s.summary.last_ts,
    };
    cur.sessions += 1;
    cur.cost += s.totals.cost_usd;
    cur.tokens +=
      s.totals.input + s.totals.output + s.totals.cache_read + s.totals.cache_write;
    if (s.summary.last_ts > cur.lastTs) cur.lastTs = s.summary.last_ts;
    map.set(key, cur);
  }
  return [...map.values()].sort(
    (a, b) => b.tokens - a.tokens || b.cost - a.cost || b.sessions - a.sessions || b.lastTs.localeCompare(a.lastTs),
  );
}

export function fleetRecent(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort(
    (a, b) =>
      b.summary.last_ts.localeCompare(a.summary.last_ts) ||
      a.summary.session_id.localeCompare(b.summary.session_id),
  );
}

/**
 * What a person might need to walk back to.
 *
 * Waiting outranks running: a session that has stopped for a decision is the
 * one going nowhere, and a session that is both is waiting, not merely busy.
 */
export function fleetAttention(rows: SessionRow[]): SessionRow[] {
  const byRecent = (a: SessionRow, b: SessionRow) => b.summary.last_ts.localeCompare(a.summary.last_ts);
  const waiting = rows.filter((s) => s.needs_input).sort(byRecent);
  const busy = rows.filter((s) => s.busy && !s.needs_input).sort(byRecent);
  return [...waiting, ...busy];
}

export type TrendPoint = {
  /** Midnight of the day, as a comparable key. */
  day: number;
  label: string;
  sessions: number;
  tokens: number;
  cost: number;
};

/**
 * One point per day, oldest first, with the empty days filled in.
 *
 * The gaps are the point: a fourteen-day window that skipped the days with
 * nothing in them would join Thursday straight to Monday and draw that weekend
 * as one long bar. Every day is present whether or not anything landed on it,
 * so a quiet stretch reads as quiet rather than as absence.
 */
export function fleetTrend(rows: SessionRow[], now: number, days = 14): TrendPoint[] {
  const out: TrendPoint[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - back);
    out.push({ day: d.getTime(), label: date(d.getTime()), sessions: 0, tokens: 0, cost: 0 });
  }
  for (const s of rows) {
    const ts = new Date(s.summary.last_ts).getTime();
    if (!Number.isFinite(ts)) continue;
    const target = out.find((p) => p.day === startOfDay(ts));
    if (!target) continue;
    target.sessions += 1;
    target.tokens +=
      s.totals.input + s.totals.output + s.totals.cache_read + s.totals.cache_write;
    target.cost += s.totals.cost_usd;
  }
  return out;
}

/** 0–100. A zero whole is an empty bar, not a NaN width. */
export function shareOf(part: number, whole: number): number {
  if (!(part > 0) || !(whole > 0)) return 0;
  return Math.min(100, (part / whole) * 100);
}
