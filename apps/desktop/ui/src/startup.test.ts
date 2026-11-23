import { describe, expect, test } from "bun:test";
import {
  startupCanEnter,
  startupDisplayedStage,
  startupStage,
  type StartupInput,
} from "./startup";

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

  test("a retry shows the service starting again instead of the frozen failure", () => {
    // Health stays up while another program holds the port, so the failure
    // stage never moves on its own. The click has to change what is on screen.
    expect(startupDisplayedStage("service-error", true)).toBe("service");
    expect(startupDisplayedStage("sessions-error", true)).toBe("service");
    expect(startupDisplayedStage("service-error", false)).toBe("service-error");
  });

  test("a taken port stays a service failure even when something answers health", () => {
    // The program holding the port can answer /health. That used to look like
    // this launch's service, and the screen then sat on "connecting to
    // OpenCode", retrying a backend that belongs to the other process.
    expect(
      stage({ health: "up", connections: "unreachable", sessions: "loading", portBlocked: true }),
    ).toBe("service-error");
    expect(stage({ portBlocked: true })).toBe("service-error");
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
