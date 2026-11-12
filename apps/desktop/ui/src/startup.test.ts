import { describe, expect, test } from "bun:test";
import { startupCanEnter, startupStage, syncProgress, type StartupInput } from "./startup";

const base: StartupInput = {
  health: "up",
  connections: "connected",
  sessions: "ready",
};

const stage = (patch: Partial<StartupInput>) => startupStage({ ...base, ...patch });

describe("startupStage", () => {
  test("waits for the service before saying anything about backends", () => {
    expect(stage({ health: "checking" })).toBe("service");
    expect(stage({ health: "down" })).toBe("service-error");
  });

  test("treats a backend being dialed as connecting, not as absent", () => {
    expect(stage({ connections: "attaching" })).toBe("opencode");
    expect(stage({ connections: "pending" })).toBe("opencode");
  });

  test("a connection read that lost the race is retried as connecting", () => {
    expect(stage({ connections: "unreachable" })).toBe("opencode");
  });

  test("waits for the first session list once a backend is up", () => {
    expect(stage({ sessions: "loading" })).toBe("sessions");
    expect(stage({ sessions: "error" })).toBe("sessions-error");
  });

  test("a running sync does not hold the launch: the list is local", () => {
    // The import adds to a list that is read from the local store, so it is
    // background work — showing it as a launch stage kept the window on the
    // launch surface for as long as the backend took to walk its projects.
    expect(stage({})).toBe("ready");
  });

  test("a backend that never connected is a degraded launch, not a spinner", () => {
    for (const connections of ["failed", "missing", "idle"] as const) {
      expect(stage({ connections })).toBe("degraded");
    }
  });

  test("waits for the local list before calling a failed backend degraded", () => {
    expect(stage({ connections: "failed", sessions: "loading" })).toBe("sessions");
    expect(stage({ connections: "failed", sessions: "error" })).toBe("sessions-error");
  });

  test("is ready only with a backend and a settled list", () => {
    expect(stage({})).toBe("ready");
  });
});

describe("startupCanEnter", () => {
  test("always lets the reader into a degraded launch", () => {
    expect(startupCanEnter("degraded", { elapsedMs: 0, sessionsReady: true })).toBe(true);
  });

  test("only offers local history while the backend is still being dialed", () => {
    expect(
      startupCanEnter("opencode", { elapsedMs: 5_000, sessionsReady: true }),
    ).toBe(false);
    expect(
      startupCanEnter("opencode", { elapsedMs: 12_000, sessionsReady: true }),
    ).toBe(true);
    expect(
      startupCanEnter("opencode", { elapsedMs: 12_000, sessionsReady: false }),
    ).toBe(false);
  });

  test("does not offer a door before the local list exists", () => {
    expect(startupCanEnter("sessions", { elapsedMs: 30_000, sessionsReady: false })).toBe(false);
    expect(startupCanEnter("service-error", { elapsedMs: 30_000, sessionsReady: false })).toBe(false);
  });
});

describe("syncProgress", () => {
  test("is absent until a sync starts", () => {
    expect(syncProgress(new Map())).toBeUndefined();
  });

  test("sums every connection still syncing", () => {
    const ticks = new Map([
      ["a", { done: 3, total: 10 }],
      ["b", { done: 1, total: 5 }],
    ]);
    expect(syncProgress(ticks)).toEqual({ done: 4, total: 15, indeterminate: false });
  });

  test("a scan without a total is indeterminate", () => {
    const ticks = new Map([
      ["a", { done: 0, total: 0 }],
      ["b", { done: 1, total: 5 }],
    ]);
    expect(syncProgress(ticks)).toEqual({ done: 1, total: 5, indeterminate: true });
  });
});
