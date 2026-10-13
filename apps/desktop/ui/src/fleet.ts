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

export const TIME_BUCKETS = ["time.today", "time.yesterday", "time.week", "time.older"] as const;
export type TimeBucket = (typeof TIME_BUCKETS)[number];

export function dayBucket(iso: string, now: number): TimeBucket {
  const ts = new Date(iso).getTime();
  if (!Number.isFinite(ts)) return "time.older";
  const start = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const diff = Math.round((start(now) - start(ts)) / 86_400_000);
  if (diff <= 0) return "time.today";
  if (diff === 1) return "time.yesterday";
  if (diff < 7) return "time.week";
  return "time.older";
}

export type FleetTotals = {
  sessions: number;
  cost: number;
  input: number;
  output: number;
  tools: number;
  projects: number;
};

export function fleetTotals(rows: SessionRow[]): FleetTotals {
  const projects = new Set<string>();
  let cost = 0;
  let input = 0;
  let output = 0;
  let tools = 0;
  for (const s of rows) {
    cost += s.totals.cost_usd;
    input += s.totals.input;
    output += s.totals.output;
    tools += s.totals.tool_calls;
    projects.add(realWorkspace(s.workspace ?? s.summary.workspace) ?? "");
  }
  return { sessions: rows.length, cost, input, output, tools, projects: projects.size };
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
    cur.tokens += s.totals.input + s.totals.output;
    if (s.summary.last_ts > cur.lastTs) cur.lastTs = s.summary.last_ts;
    map.set(key, cur);
  }
  return [...map.values()].sort(
    (a, b) => b.cost - a.cost || b.sessions - a.sessions || b.lastTs.localeCompare(a.lastTs),
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

export type ActivityRollup = { key: TimeBucket; sessions: number; cost: number };

/** Every bucket, including the empty ones, so the column does not change shape as days roll. */
export function fleetActivity(rows: SessionRow[], now: number): ActivityRollup[] {
  const acc = new Map<TimeBucket, ActivityRollup>();
  for (const key of TIME_BUCKETS) acc.set(key, { key, sessions: 0, cost: 0 });
  for (const s of rows) {
    const cur = acc.get(dayBucket(s.summary.last_ts, now))!;
    cur.sessions += 1;
    cur.cost += s.totals.cost_usd;
  }
  return TIME_BUCKETS.map((key) => acc.get(key)!);
}

/** 0–100. A zero whole is an empty bar, not a NaN width. */
export function shareOf(part: number, whole: number): number {
  if (!(part > 0) || !(whole > 0)) return 0;
  return Math.min(100, (part / whole) * 100);
}
