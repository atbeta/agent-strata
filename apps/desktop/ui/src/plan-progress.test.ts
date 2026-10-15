import { describe, expect, test } from "bun:test";
import {
  PLAN_STRIP_PREFIX,
  planKey,
  planOpensOnEntry,
  planProgress,
  planVisible,
  readPlanChoice,
  writePlanChoice,
  type PlanItem,
} from "./plan-progress";

const item = (content: string, status: PlanItem["status"]): PlanItem => ({ content, status });

describe("planProgress", () => {
  test("empty and undefined plans report nothing", () => {
    expect(planProgress(undefined)).toEqual({ done: 0, total: 0, current: undefined, allDone: false });
    expect(planProgress([])).toEqual({ done: 0, total: 0, current: undefined, allDone: false });
  });

  test("counts completed items", () => {
    const p = planProgress([item("a", "completed"), item("b", "pending"), item("c", "completed")]);
    expect(p.done).toBe(2);
    expect(p.total).toBe(3);
    expect(p.allDone).toBe(false);
  });

  test("current prefers in_progress over an earlier pending", () => {
    const p = planProgress([item("wait", "pending"), item("now", "in_progress"), item("later", "pending")]);
    expect(p.current).toBe("now");
  });

  test("current falls back to the first pending", () => {
    const p = planProgress([item("done", "completed"), item("next", "pending"), item("last", "pending")]);
    expect(p.current).toBe("next");
  });

  test("all completed has no current and is allDone", () => {
    const p = planProgress([item("a", "completed"), item("b", "completed")]);
    expect(p.current).toBeUndefined();
    expect(p.allDone).toBe(true);
  });
});

describe("planVisible", () => {
  const mixed = [item("a", "completed"), item("b", "in_progress")];
  const done = [item("a", "completed")];
  test("no plan never shows", () => {
    expect(planVisible(undefined, true)).toBe(false);
    expect(planVisible([], true)).toBe(false);
  });
  test("unfinished plan shows whether running or idle", () => {
    expect(planVisible(mixed, true)).toBe(true);
    expect(planVisible(mixed, false)).toBe(true);
  });
  test("a finished plan hides when idle but shows while generating", () => {
    expect(planVisible(done, false)).toBe(false);
    expect(planVisible(done, true)).toBe(true);
  });
});

describe("plan strip storage", () => {
  const store = (seed: Record<string, string> = {}) => {
    const map = new Map(Object.entries(seed));
    return {
      map,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, value);
      },
    };
  };

  test("an untouched session has made no choice at all", () => {
    // Not `false`. The difference is the whole mechanism: an absent answer is
    // where the entry rule gets to speak, and only a real toggle outranks it.
    expect(readPlanChoice("s1", store())).toBeUndefined();
    expect(readPlanChoice("s1", store({ [planKey("s1")]: "closed" }))).toBe(false);
    expect(readPlanChoice("s1", store({ [planKey("s1")]: "open" }))).toBe(true);
  });

  test("one session's choice is not another's", () => {
    // Shared, expanding a plan in one session expanded it in every other, and
    // collapsing it there too — the reader's choice made for them, in a plan
    // they had not looked at.
    const s = store();
    writePlanChoice("s1", true, s);
    expect(readPlanChoice("s1", s)).toBe(true);
    expect(readPlanChoice("s2", s)).toBeUndefined();
    writePlanChoice("s2", false, s);
    expect(readPlanChoice("s1", s)).toBe(true);
    expect(readPlanChoice("s2", s)).toBe(false);
  });

  test("round trips open and closed", () => {
    const s = store();
    writePlanChoice("s1", true, s);
    expect(s.getItem(planKey("s1"))).toBe("open");
    expect(readPlanChoice("s1", s)).toBe(true);
    writePlanChoice("s1", false, s);
    expect(s.getItem(planKey("s1"))).toBe("closed");
    expect(readPlanChoice("s1", s)).toBe(false);
  });

  test("a store that refuses keeps the default", () => {
    const refusing = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    };
    expect(readPlanChoice("s1", refusing)).toBeUndefined();
    expect(() => writePlanChoice("s1", true, refusing)).not.toThrow();
  });
});

describe("plan opens on entry", () => {
  const item = (status: PlanItem["status"], content = "x"): PlanItem => ({ content, status });

  test("a live session with work left opens the strip by itself", () => {
    expect(planOpensOnEntry([item("pending")], true)).toBe(true);
    expect(planOpensOnEntry([item("completed"), item("in_progress")], true)).toBe(true);
  });

  test("a finished plan does not open itself", () => {
    // An expanded list of completed steps belongs to the transcript, directly
    // above the dock, not to the dock.
    expect(planOpensOnEntry([item("completed"), item("completed")], false)).toBe(false);
  });

  test("a settled session does not open itself either", () => {
    expect(planOpensOnEntry([item("in_progress")], false)).toBe(false);
  });

  test("no plan is nothing to open", () => {
    expect(planOpensOnEntry(undefined, true)).toBe(false);
    expect(planOpensOnEntry([], true)).toBe(false);
  });
});
