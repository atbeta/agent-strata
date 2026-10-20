import { describe, expect, test } from "bun:test";
import {
  dayLabel,
  groupVisible,
  lensActive,
  lensCount,
  lensTypes,
  NO_LENS,
  readLens,
  sessionVisible,
  writeLens,
  type LensSession,
  type ProjectLens,
} from "./project-view";

const NOW = new Date("2026-10-21T12:00:00").getTime();

const session = (over: Partial<LensSession> = {}): LensSession => ({
  title: "修端口",
  backend: "opencode",
  lastTs: "2026-10-21T09:00:00.000Z",
  ...over,
});

const project = { label: "Beta", path: "D:\\Code\\Beta" };

/** A storage that only lives in memory. */
function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

describe("the project lens", () => {
  test("with nothing set, every session is visible", () => {
    expect(sessionVisible(NO_LENS, session(), project, NOW)).toBe(true);
    expect(lensActive(NO_LENS)).toBe(false);
  });

  test("a query keeps what is named, and a project named keeps all of it", () => {
    const lens = { ...NO_LENS, query: "beta" };
    expect(sessionVisible(lens, session(), project, NOW)).toBe(true);
    expect(sessionVisible(lens, session(), { label: "relay", path: "E:\\Code\\relay" }, NOW)).toBe(false);
    // The path counts too: the name on the header is only its last segment.
    expect(sessionVisible(lens, session(), { label: "strata", path: "D:\\Code\\beta-core" }, NOW)).toBe(true);
  });

  test("a query also finds a session by its own title", () => {
    const lens = { ...NO_LENS, query: "端口" };
    expect(sessionVisible(lens, session({ title: "修端口" }), project, NOW)).toBe(true);
    expect(sessionVisible(lens, session({ title: "别的会话" }), project, NOW)).toBe(false);
  });

  test("a query is not a case-sensitive thing to type", () => {
    expect(sessionVisible({ ...NO_LENS, query: "BETA" }, session(), project, NOW)).toBe(true);
    expect(sessionVisible({ ...NO_LENS, query: "  beta  " }, session(), project, NOW)).toBe(true);
  });

  test("the status picks out the running, the waiting and the idle", () => {
    const busy = session({ busy: true });
    const waiting = session({ needsInput: true });
    const idle = session();
    expect(sessionVisible({ ...NO_LENS, status: "busy" }, busy, project, NOW)).toBe(true);
    // A session waiting for a decision is not running, however busy it was.
    expect(sessionVisible({ ...NO_LENS, status: "busy" }, waiting, project, NOW)).toBe(false);
    expect(sessionVisible({ ...NO_LENS, status: "waiting" }, waiting, project, NOW)).toBe(true);
    expect(sessionVisible({ ...NO_LENS, status: "waiting" }, busy, project, NOW)).toBe(false);
    expect(sessionVisible({ ...NO_LENS, status: "idle" }, idle, project, NOW)).toBe(true);
    expect(sessionVisible({ ...NO_LENS, status: "idle" }, busy, project, NOW)).toBe(false);
  });

  test("the period looks back from now, in the reader's own days", () => {
    const today = session({ lastTs: "2026-10-21T09:00:00.000Z" });
    const week = session({ lastTs: "2026-10-16T09:00:00.000Z" });
    const month = session({ lastTs: "2026-10-03T09:00:00.000Z" });
    const older = session({ lastTs: "2026-09-20T09:00:00.000Z" });
    const lens = (period: ProjectLens["period"]) => ({ ...NO_LENS, period });
    expect(sessionVisible(lens("today"), today, project, NOW)).toBe(true);
    expect(sessionVisible(lens("today"), week, project, NOW)).toBe(false);
    expect(sessionVisible(lens("week"), week, project, NOW)).toBe(true);
    expect(sessionVisible(lens("week"), month, project, NOW)).toBe(false);
    expect(sessionVisible(lens("month"), month, project, NOW)).toBe(true);
    expect(sessionVisible(lens("month"), older, project, NOW)).toBe(false);
  });

  test("the type keeps one backend and drops the other", () => {
    const lens = { ...NO_LENS, type: "acp" };
    expect(sessionVisible(lens, session({ backend: "acp" }), project, NOW)).toBe(true);
    expect(sessionVisible(lens, session({ backend: "opencode" }), project, NOW)).toBe(false);
  });

  test("a group with rows left is in, one without is out", () => {
    expect(groupVisible(NO_LENS, { rows: 2, total: 2, path: "D:\\Code\\Beta" })).toBe(true);
    // A group emptied by the lens is noise: an empty header under a list.
    expect(groupVisible(NO_LENS, { rows: 0, total: 3, path: "D:\\Code\\Beta" })).toBe(false);
  });

  test("an empty project stays unless the reader asks for it to go", () => {
    const empty = { rows: 0, total: 0, path: "D:\\Code\\Beta" };
    expect(groupVisible(NO_LENS, empty)).toBe(true);
    expect(groupVisible({ ...NO_LENS, hideEmpty: true }, empty)).toBe(false);
  });

  test("the project the reader is standing in stays", () => {
    const lens = { ...NO_LENS, hideEmpty: true };
    expect(groupVisible(lens, { rows: 0, total: 0, path: "D:\\Code\\Beta" }, "D:\\Code\\Beta")).toBe(true);
    expect(groupVisible(lens, { rows: 0, total: 0, path: "E:\\Code\\other" }, "D:\\Code\\Beta")).toBe(false);
  });

  test("a lens is only active when it narrows something", () => {
    expect(lensActive({ ...NO_LENS, query: "   " })).toBe(false);
    expect(lensActive({ ...NO_LENS, query: "beta" })).toBe(true);
    expect(lensActive({ ...NO_LENS, hideEmpty: true })).toBe(true);
    expect(lensActive({ ...NO_LENS, groupBy: "day" })).toBe(true);
    expect(lensActive({ ...NO_LENS, status: "busy" })).toBe(true);
    expect(lensActive({ ...NO_LENS, period: "week" })).toBe(true);
    expect(lensActive({ ...NO_LENS, type: "acp" })).toBe(true);
  });

  test("the count is one per axis that is off rest, and blank space is not one", () => {
    expect(lensCount(NO_LENS)).toBe(0);
    expect(lensCount({ ...NO_LENS, query: "   " })).toBe(0);
    expect(lensCount({ ...NO_LENS, query: "beta", status: "busy", period: "week" })).toBe(3);
    expect(lensActive(NO_LENS)).toBe(lensCount(NO_LENS) > 0);
  });

  test("the lens survives a restart, and a broken one reads as no lens", () => {
    const storage = memoryStorage();
    writeLens({ ...NO_LENS, query: "beta", hideEmpty: true, period: "week" }, storage);
    expect(readLens(storage)).toEqual({ ...NO_LENS, query: "beta", hideEmpty: true, period: "week" });

    const broken = memoryStorage({ "strata.projectLens.v2": "{not json" });
    expect(readLens(broken)).toEqual(NO_LENS);

    const half = memoryStorage({ "strata.projectLens.v2": JSON.stringify({ query: 7 }) });
    expect(readLens(half)).toEqual(NO_LENS);
  });

  test("a lens from before the categories keeps what it had", () => {
    const storage = memoryStorage({
      "strata.projectLens.v1": JSON.stringify({ query: "beta", hideEmpty: true }),
    });
    expect(readLens(storage)).toEqual({ ...NO_LENS, query: "beta", hideEmpty: true });
  });

  test("one unreadable field does not throw the rest of the lens away", () => {
    const storage = memoryStorage({
      "strata.projectLens.v2": JSON.stringify({ query: "beta", period: "soon" }),
    });
    expect(readLens(storage)).toEqual({ ...NO_LENS, query: "beta", period: "all" });
  });

  test("the type menu offers the backends the list holds", () => {
    expect(lensTypes(["opencode", "opencode", "acp", ""])).toEqual(["acp", "opencode"]);
    expect(lensTypes([])).toEqual([]);
  });

  test("a day group says today and yesterday out loud", () => {
    expect(dayLabel("2026-10-21", NOW)).toBe("今天");
    expect(dayLabel("2026-10-20", NOW)).toBe("昨天");
    expect(dayLabel("2026-10-11", NOW)).not.toBe("今天");
  });
});
