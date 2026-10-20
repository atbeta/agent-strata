import { describe, expect, test } from "bun:test";
import { connectionPhase, connectionPlacement } from "../src/connection-phase";

describe("connectionPhase", () => {
  test("a live connection wins, whichever backend it is", () => {
    expect(
      connectionPhase({
        connected: true,
        attempts: [{ phase: "failed" }, { phase: "retrying" }],
        launchState: "missing",
      }),
    ).toBe("connected");
  });

  test("an attempt still in flight is attaching, including one that is not opencode", () => {
    expect(
      connectionPhase({
        connected: false,
        attempts: [{ phase: "retrying" }],
        launchState: "unmanaged",
      }),
    ).toBe("attaching");
  });

  test("a spawn still starting is attaching before any attempt is recorded", () => {
    expect(connectionPhase({ connected: false, attempts: [], launchState: "starting" })).toBe("attaching");
    expect(connectionPhase({ connected: false, attempts: [], launchState: "restarting" })).toBe("attaching");
  });

  test("a process that is merely up, or a preference for external, is not a connection in progress", () => {
    expect(connectionPhase({ connected: false, attempts: [], launchState: "running" })).toBe("idle");
    expect(connectionPhase({ connected: false, attempts: [], launchState: "external" })).toBe("idle");
    expect(connectionPhase({ connected: false, attempts: [], launchState: "unmanaged" })).toBe("idle");
    expect(connectionPhase({ connected: false, attempts: [], launchState: "stopped" })).toBe("idle");
  });

  test("a given-up attempt is a failure once nothing is still coming", () => {
    expect(
      connectionPhase({
        connected: false,
        attempts: [{ phase: "failed" }],
        launchState: "stopped",
      }),
    ).toBe("failed");
  });

  test("a spawn still in progress hides a failure that has not settled", () => {
    expect(
      connectionPhase({
        connected: false,
        attempts: [{ phase: "failed" }],
        launchState: "restarting",
      }),
    ).toBe("attaching");
  });

  test("a missing binary is its own state when nobody is being dialed", () => {
    expect(connectionPhase({ connected: false, attempts: [], launchState: "missing" })).toBe("missing");
  });
});

describe("connectionPlacement", () => {
  const url = "http://127.0.0.1:4096";

  test("the address the shell spawned is the embedded server", () => {
    expect(connectionPlacement("opencode", `${url}/`, { mode: "embed", url })).toBe("embed");
  });

  test("another address beside an embedded server is external", () => {
    expect(connectionPlacement("opencode", "http://127.0.0.1:53349", { mode: "embed", url })).toBe("external");
  });

  test("external mode labels every opencode address external", () => {
    expect(connectionPlacement("opencode", url, { mode: "external", url })).toBe("external");
  });

  test("embed mode without a url yet does not guess", () => {
    expect(connectionPlacement("opencode", url, { mode: "embed" })).toBeUndefined();
  });

  test("an acp agent has no embed", () => {
    expect(connectionPlacement("acp", "acp://opencode acp", { mode: "embed", url })).toBeUndefined();
  });
});
