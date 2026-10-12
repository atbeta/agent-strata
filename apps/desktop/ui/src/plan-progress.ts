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

/** A finished plan stops being news once the run settles; while it runs, it still says what is left. */
export function planVisible(plan: readonly PlanItem[] | undefined, generating: boolean): boolean {
  const p = planProgress(plan);
  return p.total > 0 && (!p.allDone || generating);
}

export const PLAN_STRIP_KEY = "strata.plan-strip";

export function readPlanOpen(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  try {
    return storage.getItem(PLAN_STRIP_KEY) === "open";
  } catch {
    return false;
  }
}

export function writePlanOpen(open: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
  try {
    storage.setItem(PLAN_STRIP_KEY, open ? "open" : "closed");
  } catch {
    // Private mode can refuse storage; the default still gives a usable strip.
  }
}
