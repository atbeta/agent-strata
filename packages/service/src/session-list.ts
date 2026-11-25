import { aggregate, runningShell, type SessionView, type Totals } from "@agent-strata/projector";
import type { LiveOverlay } from "./live";
import type { ViewCache } from "./views";

export type Usage = ReturnType<typeof aggregate>;

/**
 * What the sidebar row and the overview read off one session's view.
 *
 * Small on purpose: it is kept for every session in the list, where a whole
 * view is kept only for the few hundred the view cache holds. A page of the
 * list larger than that cache, read through whole views, evicted each session
 * before the next request came back to it, so every request reprojected the
 * whole page and pushed out the session the reader had open.
 */
export function listRow(view: SessionView) {
  return {
    backend: view.backend,
    status: view.status,
    busy: view.busy,
    retry: view.retry,
    compacting: view.compacting === true,
    session_error: view.session_error,
    totals: view.totals,
    title: view.title,
    workspace: view.workspace,
    parent: view.parent_session_id,
    archived: view.archived === true,
    deleted: view.deleted === true,
    questions: view.pending_questions,
    shell: runningShell(view),
    usage: aggregate([view]),
  };
}

export type ListRow = ReturnType<typeof listRow>;

/**
 * The row for one session: from the summary cache while only stored events
 * make it up, from the full view while a live overlay is drawing on top.
 */
export function listRowOf(
  sessionId: string,
  deps: { views: ViewCache; live: LiveOverlay; sessionView(sessionId: string): SessionView },
): ListRow {
  if (deps.live.has(sessionId)) return listRow(deps.sessionView(sessionId));
  try {
    return deps.views.summary(sessionId, "list-row", listRow);
  } catch {
    // An owned session with no events yet has a view the cache cannot build.
    return listRow(deps.sessionView(sessionId));
  }
}

const addTotals = (dst: Totals, src: Totals) => {
  for (const k of Object.keys(dst) as (keyof Totals)[]) dst[k] += src[k];
};

/** `aggregate` over many views, put together from each view's own aggregate. */
export function mergeUsage(parts: Usage[]): Usage {
  const out = aggregate([]);
  for (const part of parts) {
    addTotals(out.total, part.total);
    for (const [backend, totals] of Object.entries(part.by_backend)) {
      const dst = (out.by_backend[backend] ??= zeroOf(totals));
      addTotals(dst, totals);
    }
    for (const [model, m] of Object.entries(part.by_model)) {
      const dst = (out.by_model[model] ??= { input: 0, output: 0, cost_usd: 0, turns: 0 });
      dst.input += m.input;
      dst.output += m.output;
      dst.cost_usd += m.cost_usd;
      dst.turns += m.turns;
    }
  }
  return out;
}

const zeroOf = (t: Totals): Totals =>
  Object.fromEntries(Object.keys(t).map((k) => [k, 0])) as unknown as Totals;
