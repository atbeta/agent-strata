import { DEFAULT_SECRET_PATTERNS, redact, type Event } from "@agent-strata/schema";
import type { Store } from "@agent-strata/store";
import type { SessionView, Totals, Turn } from "@agent-strata/projector";

export interface ExportOptions {
  session_id?: string;
  backend?: string;
  since?: string;
  until?: string;
  /** re-run secret redaction over event bodies. Default true. */
  redact?: boolean;
  /** prepend a `{"casf":"0.1",...}` header line. Default true. */
  include_header?: boolean;
}

/**
 * Export stored events as CASF JSONL: an optional header line, then one
 * stored event per line. Re-importing the lines through `store.append` is a
 * no-op because event ids are stable and appends are idempotent.
 */
export function exportEvents(store: Store, opts: ExportOptions = {}): string {
  const events = store.query({
    session_id: opts.session_id,
    backend: opts.backend,
    since: opts.since,
    until: opts.until,
    order: "asc",
    limit: 10_000,
  });
  const scrub = opts.redact !== false;
  const lines = events.map((e) =>
    JSON.stringify(scrub ? redact(e, { patterns: DEFAULT_SECRET_PATTERNS }) : e),
  );
  if (opts.include_header !== false) {
    lines.unshift(
      JSON.stringify({
        casf: "0.1",
        exported_at: new Date().toISOString(),
        event_count: events.length,
      }),
    );
  }
  return lines.join("\n") + "\n";
}

export interface TurnDescriptor {
  turn_id: string;
  first_user_text: string | null;
}

export interface TurnPair {
  /** null when b has more turns than a (and vice versa for b_turn). */
  a_turn: TurnDescriptor | null;
  b_turn: TurnDescriptor | null;
  same_prompt: boolean;
  tools: { only_a: string[]; only_b: string[]; shared: string[] };
  delta: {
    input: number;
    output: number;
    cost_usd: number;
    duration_ms: number | null;
  };
}

export interface SessionComparison {
  a: { session_id: string; backend: string; model?: string; totals: Totals };
  b: { session_id: string; backend: string; model?: string; totals: Totals };
  turn_pairs: TurnPair[];
  summary: {
    turn_pairs: number;
    same_prompt: number;
    shared_tools: string[];
    only_a_tools: string[];
    only_b_tools: string[];
    delta_totals: { input: number; output: number; cost_usd: number };
  };
}

const firstText = (t: Turn): string | null => {
  for (const b of t.user ?? []) if (b.type === "text" && b.text) return b.text;
  return null;
};

const sessionModel = (v: SessionView): string | undefined => {
  for (const t of v.turns) for (const a of t.assistant) if (a.model) return a.model;
  return undefined;
};

const sessionInfo = (v: SessionView) => ({
  session_id: v.session_id,
  backend: v.backend,
  model: sessionModel(v),
  totals: v.totals,
});

const turnUsage = (t: Turn) => {
  let input = 0;
  let output = 0;
  let cost_usd = 0;
  let latency_ms: number | null = null;
  for (const a of t.assistant) {
    input += a.usage?.input ?? 0;
    output += a.usage?.output ?? 0;
    cost_usd += a.cost_usd ?? 0;
    if (a.latency_ms !== undefined)
      latency_ms = (latency_ms ?? 0) + a.latency_ms;
  }
  return { input, output, cost_usd, latency_ms };
};

const toolNames = (ts: Turn[]) =>
  [...new Set(ts.flatMap((t) => t.tool_calls.map((c) => c.tool)))];

/**
 * Pair two sessions' user turns 1:1 by order and diff them: whether the
 * prompts match, which tools each side used, and per-turn usage deltas.
 * This is the data layer behind the "same task, two agents" view.
 */
export function compareSessions(a: SessionView, b: SessionView): SessionComparison {
  const turn_pairs: TurnPair[] = [];
  const len = Math.max(a.turns.length, b.turns.length);
  for (let i = 0; i < len; i++) {
    const ta = a.turns[i];
    const tb = b.turns[i];
    const aTurn = ta
      ? { turn_id: ta.turn_id, first_user_text: firstText(ta) }
      : null;
    const bTurn = tb
      ? { turn_id: tb.turn_id, first_user_text: firstText(tb) }
      : null;
    const aTools = ta ? [...new Set(ta.tool_calls.map((c) => c.tool))] : [];
    const bTools = tb ? [...new Set(tb.tool_calls.map((c) => c.tool))] : [];
    const ua = ta ? turnUsage(ta) : { input: 0, output: 0, cost_usd: 0, latency_ms: null };
    const ub = tb ? turnUsage(tb) : { input: 0, output: 0, cost_usd: 0, latency_ms: null };
    turn_pairs.push({
      a_turn: aTurn,
      b_turn: bTurn,
      same_prompt: aTurn?.first_user_text != null && aTurn.first_user_text === bTurn?.first_user_text,
      tools: {
        only_a: aTools.filter((t) => !bTools.includes(t)),
        only_b: bTools.filter((t) => !aTools.includes(t)),
        shared: aTools.filter((t) => bTools.includes(t)),
      },
      delta: {
        input: ua.input - ub.input,
        output: ua.output - ub.output,
        cost_usd: ua.cost_usd - ub.cost_usd,
        duration_ms:
          ua.latency_ms !== null && ub.latency_ms !== null
            ? ua.latency_ms - ub.latency_ms
            : null,
      },
    });
  }

  const aAll = toolNames(a.turns);
  const bAll = toolNames(b.turns);
  return {
    a: sessionInfo(a),
    b: sessionInfo(b),
    turn_pairs,
    summary: {
      turn_pairs: turn_pairs.length,
      same_prompt: turn_pairs.filter((p) => p.same_prompt).length,
      shared_tools: aAll.filter((t) => bAll.includes(t)),
      only_a_tools: aAll.filter((t) => !bAll.includes(t)),
      only_b_tools: bAll.filter((t) => !aAll.includes(t)),
      delta_totals: {
        input: a.totals.input - b.totals.input,
        output: a.totals.output - b.totals.output,
        cost_usd: a.totals.cost_usd - b.totals.cost_usd,
      },
    },
  };
}

export type { Event };
