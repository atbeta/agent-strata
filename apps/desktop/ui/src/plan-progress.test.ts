import { describe, expect, test } from "bun:test";
import {
  PLAN_STRIP_KEY,
  planProgress,
  planVisible,
  readPlanOpen,
  writePlanOpen,
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

  test("defaults to collapsed", () => {
    expect(readPlanOpen(store())).toBe(false);
    expect(readPlanOpen(store({ [PLAN_STRIP_KEY]: "closed" }))).toBe(false);
  });

  test("round trips open and closed", () => {
    const s = store();
    writePlanOpen(true, s);
    expect(s.getItem(PLAN_STRIP_KEY)).toBe("open");
    expect(readPlanOpen(s)).toBe(true);
    writePlanOpen(false, s);
    expect(readPlanOpen(s)).toBe(false);
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
    expect(readPlanOpen(refusing)).toBe(false);
    expect(() => writePlanOpen(true, refusing)).not.toThrow();
  });
});
