import { realWorkspace, type DailyUsageRow, type SessionRow } from "./api";
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

/** Local `YYYY-MM-DD` — the same shape the service's `day` fields arrive in,
 *  since the UI asks for buckets in the browser's own zone. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The local days a window covers, as a predicate over bucket day keys.
 *
 * A week is seven calendar days — `key(today − 6)` to today — and a month is
 * its `YYYY-MM` prefix, so a window is defined by what the service reported,
 * not by subtracting milliseconds across a possible DST step.
 */
export function periodKeys(period: Period, now: number): (day: string) => boolean {
  if (period === "total") return () => true;
  const today = dayKey(now);
  if (period === "today") return (day) => day === today;
  if (period === "week") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 6);
    const start = dayKey(d.getTime());
    return (day) => day >= start && day <= today;
  }
  const prefix = today.slice(0, 7);
  return (day) => day.startsWith(prefix);
}

/** Buckets inside the period that belong to the page's session list. Buckets
 *  for sessions outside the list do not count — the page's scope is the
 *  list's scope. */
function scopedBuckets(
  sessions: SessionRow[],
  buckets: DailyUsageRow[],
  inWindow: (day: string) => boolean,
): DailyUsageRow[] {
  const ids = new Set(sessions.map((s) => s.summary.session_id));
  return buckets.filter((b) => ids.has(b.session_id) && inWindow(b.day));
}

/**
 * The rows touched inside a period.
 *
 * A session is in when any bucket of its lands in the window — the bucket is
 * a day's own usage, so a long session spreads across the days it actually
 * ran instead of dragging its lifetime into wherever its last event fell.
 * A session with no usage yet still counts when its last event is in the
 * window: having just been created is being active.
 */
export function inPeriod(
  rows: SessionRow[],
  buckets: DailyUsageRow[],
  period: Period,
  now: number,
): SessionRow[] {
  const inWindow = periodKeys(period, now);
  const since = periodStart(period, now);
  const active = new Set(
    scopedBuckets(rows, buckets, inWindow).map((b) => b.session_id),
  );
  return rows.filter((s) => {
    if (active.has(s.summary.session_id)) return true;
    const ts = new Date(s.summary.last_ts).getTime();
    return Number.isFinite(ts) && ts >= since;
  });
}

export type FleetTotals = {
  sessions: number;
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  tools: number;
  toolErrors: number;
  projects: number;
};

export function fleetTotals(
  rows: SessionRow[],
  buckets: DailyUsageRow[],
  period: Period,
  now: number,
): FleetTotals {
  const inWindow = periodKeys(period, now);
  const scoped = scopedBuckets(rows, buckets, inWindow);
  let cost = 0;
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let tools = 0;
  let toolErrors = 0;
  for (const b of scoped) {
    cost += b.cost_usd;
    input += b.input;
    output += b.output;
    reasoning += b.reasoning;
    cacheRead += b.cache_read;
    cacheWrite += b.cache_write;
    tools += b.tool_calls;
    toolErrors += b.tool_errors;
  }
  const active = inPeriod(rows, buckets, period, now);
  const projects = new Set<string>();
  for (const s of active) {
    projects.add(realWorkspace(s.workspace ?? s.summary.workspace) ?? "");
  }
  return {
    sessions: active.length,
    cost,
    input,
    output,
    reasoning,
    cacheRead,
    cacheWrite,
    tools,
    toolErrors,
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
  return totals.input + totals.output + totals.reasoning + totals.cacheRead + totals.cacheWrite;
}

export type TokenKey = "input" | "cacheRead" | "cacheWrite" | "output" | "reasoning";

export type TokenPart = { key: TokenKey; value: number; pct: number };

const TOKEN_ORDER: TokenKey[] = ["input", "cacheRead", "cacheWrite", "output", "reasoning"];

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
  // The prompt side is what the request was billed to send: uncached input
  // plus both cache legs. Leaving cache writes out of the whole would count
  // tokens the model was shown as if they were free.
  const whole = totals.input + totals.cacheRead + totals.cacheWrite;
  return whole > 0 ? totals.cacheRead / whole : 0;
}

export type ProjectRollup = {
  workspace?: string;
  sessions: number;
  cost: number;
  tokens: number;
  lastTs: string;
};

/** One row per directory, heaviest in-period spend first. A missing workspace
 *  shares a row. Tokens and cost are the window's own, not the session's
 *  lifetime. */
export function fleetProjects(
  rows: SessionRow[],
  buckets: DailyUsageRow[],
  period: Period,
  now: number,
): ProjectRollup[] {
  const perSession = sessionPeriodTotals(rows, buckets, period, now);
  const map = new Map<string, ProjectRollup>();
  for (const s of inPeriod(rows, buckets, period, now)) {
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
    const used = perSession.get(s.summary.session_id);
    cur.cost += used?.cost ?? 0;
    cur.tokens += used?.tokens ?? 0;
    if (s.summary.last_ts > cur.lastTs) cur.lastTs = s.summary.last_ts;
    map.set(key, cur);
  }
  return [...map.values()].sort(
    (a, b) => b.tokens - a.tokens || b.cost - a.cost || b.sessions - a.sessions || b.lastTs.localeCompare(a.lastTs),
  );
}

export function fleetRecent(
  rows: SessionRow[],
  buckets: DailyUsageRow[],
  period: Period,
  now: number,
): SessionRow[] {
  return [...inPeriod(rows, buckets, period, now)].sort(
    (a, b) =>
      b.summary.last_ts.localeCompare(a.summary.last_ts) ||
      a.summary.session_id.localeCompare(b.summary.session_id),
  );
}

/** Each session's tokens, cost and dominant model inside the window, keyed by
 *  session id — what a list row shows next to its name. */
export function sessionPeriodTotals(
  rows: SessionRow[],
  buckets: DailyUsageRow[],
  period: Period,
  now: number,
): Map<string, { tokens: number; cost: number; model: string | null }> {
  const map = new Map<string, { tokens: number; cost: number; model: string | null }>();
  const perModel = new Map<string, Map<string | null, number>>();
  for (const b of scopedBuckets(rows, buckets, periodKeys(period, now))) {
    const tokens = b.input + b.output + b.reasoning + b.cache_read + b.cache_write;
    const cur = map.get(b.session_id) ?? { tokens: 0, cost: 0, model: null };
    cur.tokens += tokens;
    cur.cost += b.cost_usd;
    map.set(b.session_id, cur);
    let mm = perModel.get(b.session_id);
    if (!mm) perModel.set(b.session_id, (mm = new Map()));
    mm.set(b.model, (mm.get(b.model) ?? 0) + tokens);
  }
  for (const [id, mm] of perModel) {
    // The model that did the most work names the row; ties keep whichever
    // came first — a photo finish does not justify a tiebreaker nobody reads.
    let best: string | null = null;
    let bestTokens = 0;
    for (const [model, tokens] of mm) {
      if (tokens > bestTokens) {
        best = model;
        bestTokens = tokens;
      }
    }
    map.get(id)!.model = best;
  }
  return map;
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

/**
 * The page's first question — is anything waiting or running — as two groups.
 * Waiting outranks running for the same reason it does in `fleetAttention`;
 * the overview just shows them separately rather than interleaved.
 */
export function fleetStatus(rows: SessionRow[]): { waiting: SessionRow[]; running: SessionRow[] } {
  const byRecent = (a: SessionRow, b: SessionRow) => b.summary.last_ts.localeCompare(a.summary.last_ts);
  return {
    waiting: rows.filter((s) => s.needs_input).sort(byRecent),
    running: rows.filter((s) => s.busy && !s.needs_input).sort(byRecent),
  };
}

export type ModelRollup = {
  /** `providerID/modelID` as the backend reported it, or null when unnamed. */
  model: string | null;
  tokens: number;
  cost: number;
  sessions: number;
};

/** One row per model that did work in the window, heaviest first. A model
 *  whose only buckets carried no tokens is not a ranking. */
export function fleetModels(
  rows: SessionRow[],
  buckets: DailyUsageRow[],
  period: Period,
  now: number,
): ModelRollup[] {
  const map = new Map<string | null, { tokens: number; cost: number; sessions: Set<string> }>();
  for (const b of scopedBuckets(rows, buckets, periodKeys(period, now))) {
    const tokens = b.input + b.output + b.reasoning + b.cache_read + b.cache_write;
    if (!(tokens > 0)) continue;
    const cur = map.get(b.model) ?? { tokens: 0, cost: 0, sessions: new Set<string>() };
    cur.tokens += tokens;
    cur.cost += b.cost_usd;
    cur.sessions.add(b.session_id);
    map.set(b.model, cur);
  }
  return [...map.entries()]
    .map(([model, v]) => ({ model, tokens: v.tokens, cost: v.cost, sessions: v.sessions.size }))
    .sort((a, b) => b.tokens - a.tokens || b.cost - a.cost || b.sessions - a.sessions);
}

export type TrendPoint = {
  /** Midnight of the day, as a comparable key. */
  day: number;
  label: string;
  sessions: number;
  tokens: number;
  cost: number;
  /** The day's tokens split like FleetTotals — what a bar's hover spells out. */
  parts: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
};

/**
 * One point per day, oldest first, with the empty days filled in.
 *
 * The gaps are the point: a fourteen-day window that skipped the days with
 * nothing in them would join Thursday straight to Monday and draw that weekend
 * as one long bar. Every day is present whether or not anything landed on it,
 * so a quiet stretch reads as quiet rather than as absence.
 */
export function fleetTrend(
  rows: SessionRow[],
  buckets: DailyUsageRow[],
  now: number,
  days = 14,
): TrendPoint[] {
  const out: TrendPoint[] = [];
  const byDay = new Map<string, TrendPoint>();
  const sessionsByDay = new Map<string, Set<string>>();
  for (let back = days - 1; back >= 0; back--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - back);
    const point: TrendPoint = {
      day: d.getTime(),
      label: date(d.getTime()),
      sessions: 0,
      tokens: 0,
      cost: 0,
      parts: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    };
    out.push(point);
    byDay.set(dayKey(point.day), point);
  }
  const ids = new Set(rows.map((s) => s.summary.session_id));
  for (const b of buckets) {
    if (!ids.has(b.session_id)) continue;
    const target = byDay.get(b.day);
    if (!target) continue;
    target.tokens += b.input + b.output + b.reasoning + b.cache_read + b.cache_write;
    target.cost += b.cost_usd;
    target.parts.input += b.input;
    target.parts.output += b.output;
    target.parts.reasoning += b.reasoning;
    target.parts.cacheRead += b.cache_read;
    target.parts.cacheWrite += b.cache_write;
    let set = sessionsByDay.get(b.day);
    if (!set) sessionsByDay.set(b.day, (set = new Set()));
    set.add(b.session_id);
  }
  for (const p of out) p.sessions = sessionsByDay.get(dayKey(p.day))?.size ?? 0;
  return out;
}

/** 0–100. A zero whole is an empty bar, not a NaN width. */
export function shareOf(part: number, whole: number): number {
  if (!(part > 0) || !(whole > 0)) return 0;
  return Math.min(100, (part / whole) * 100);
}

/**
 * A percentage with enough precision to be read, not just compared.
 *
 * Rounding to the integer was wrong in both directions: a real 0.07% share
 * printed "0%" (a figure that is wrong, which is worse than no figure), and
 * "3.4%" collapsed to "3%" makes a small share look flatter than it is. Under
 * a tenth it is only worth saying it is below one; under ten it earns a
 * decimal; past that the decimal is noise.
 */
export function fmtShare(pct: number): string {
  if (!(pct > 0)) return "0%";
  if (pct < 0.1) return "<0.1%";
  if (pct < 10) return `${Math.round(pct * 10) / 10}%`;
  return `${Math.round(pct)}%`;
}
