import type { SessionView } from "./api";

export type PlanItem = NonNullable<SessionView["plan"]>[number];

export type PlanProgress = {
  done: number;
  total: number;
  /** what the strip shows while collapsed: the active step, else the next pending one */
  current?: string;
  allDone: boolean;
};

export function planProgress(plan: readonly PlanItem[] | undefined): PlanProgress {
  const items = plan ?? [];
  const done = items.filter((i) => i.status === "completed").length;
  const current =
    items.find((i) => i.status === "in_progress")?.content ??
    items.find((i) => i.status === "pending")?.content;
  return { done, total: items.length, current, allDone: items.length > 0 && done === items.length };
}

/**
 * A finished plan stops being news once the run settles; while it runs, it still says what is left.
 *
 * This is the same rule the official client's `todoState` reaches from its other
 * end: `hide` with no todos, `open` while a live session has work left, `close`
 * once a live session finishes them, and `clear` — gone — once the session is
 * no longer live at all. A finished list is history, and the transcript holding
 * it is directly above the strip.
 */
export function planVisible(plan: readonly PlanItem[] | undefined, generating: boolean): boolean {
  const p = planProgress(plan);
  return p.total > 0 && (!p.allDone || generating);
}

/**
 * Open the strip by itself, for a session with work still in it.
 *
 * The official client calls this the boundary case, and it is what makes a plan
 * read as part of the run rather than as something to go and open: coming back
 * to a session that is still working, the one thing worth seeing without asking
 * is what it is working through. Deliberately narrow — a finished plan keeps
 * whatever the reader left it at, because an expanded list of completed steps
 * belongs to the transcript, not to the dock.
 */
export function planOpensOnEntry(plan: readonly PlanItem[] | undefined, generating: boolean): boolean {
  const p = planProgress(plan);
  return p.total > 0 && !p.allDone && generating;
}

export const PLAN_STRIP_PREFIX = "strata.plan-strip:";

/**
 * Per session, and per session for a reason.
 *
 * This used to be one key for the window, on the argument that the side panel's
 * open/closed state belongs to the window. The generalization is wrong here.
 * Which side the panel occupies is a window-level choice; whether *this
 * conversation's* plan is expanded is a property of that conversation. Shared,
 * it means expanding a plan in one session silently expands it in every other,
 * and collapsing it there too — the reader's choice made for them, in a plan
 * they have not looked at. The official client keys it by session for the same
 * reason.
 */
export function planKey(sessionId: string): string {
  return `${PLAN_STRIP_PREFIX}${sessionId}`;
}

/**
 * What the reader chose, or `undefined` when they never chose. The distinction
 * is the whole point: an absent answer is where `planOpensOnEntry` gets to
 * speak, and only an actual toggle outranks it.
 */
export function readPlanChoice(
  sessionId: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): boolean | undefined {
  try {
    const v = storage.getItem(planKey(sessionId));
    return v === null || v === undefined ? undefined : v === "open";
  } catch {
    return undefined;
  }
}

export function writePlanChoice(
  sessionId: string,
  open: boolean,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(planKey(sessionId), open ? "open" : "closed");
  } catch {
    // Private mode can refuse storage; the default still gives a usable strip.
  }
}
