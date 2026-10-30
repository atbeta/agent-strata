import { describe, expect, test } from "bun:test";
import { t } from "./i18n";
import type { DevProcess } from "./api";
import { createDevRowCache, devLogLineClass, devRunning, stateClass, stateLabel } from "./dev-state";

/**
 * The four states a background command can be in.
 *
 * The table outlives the process, so "not running" is not one thing. A command
 * that was stopped is stopped; one whose process disappeared without anyone
 * stopping it is lost; one the service found still running after it died is an
 * orphan, and was cleaned up.
 *
 * The report that prompted this was a stop that said "stopped" while the tree
 * was still running — and a registry that came back empty after a restart, so
 * nothing could be looked up at all. A state the reader cannot see is a state
 * the reader cannot trust.
 */
function process(over: Partial<DevProcess> = {}): DevProcess {
  return {
    id: "dev_1",
    session_id: "casf:test:1",
    command: "npm run dev",
    cwd: "/tmp/app",
    pid: 4242,
    started_at: Date.now(),
    exit_code: null,
    stopped: false,
    ...over,
  };
}

describe("background command states", () => {
  test("a running command is running", () => {
    const running = process({ state: "running" });
    expect(devRunning(running)).toBe(true);
    expect(stateLabel(running)).toBe(t("dev.running"));
  });

  test("a command that was stopped says so, not that it exited", () => {
    // The exit code of a command someone stopped is the kill, not a failure.
    const stopped = process({ state: "stopped", exit_code: 1, stopped: true });
    expect(devRunning(stopped)).toBe(false);
    expect(stateLabel(stopped)).toBe(t("dev.stopped"));
  });

  test("a command that vanished on its own is lost", () => {
    // It was never stopped by anyone, and the tree it belonged to is gone.
    const lost = process({ state: "lost", exit_code: 1, stopped: false });
    expect(devRunning(lost)).toBe(false);
    expect(stateLabel(lost)).toBe(t("dev.lost"));
  });

  test("a command left behind by a run that died is an orphan, and was cleaned up", () => {
    const orphan = process({ state: "orphaned", exit_code: 1, stopped: true });
    expect(devRunning(orphan)).toBe(false);
    expect(stateLabel(orphan)).toBe(t("dev.orphaned"));
    // It is not reported as merely stopped: something was there, and it was
    // found by a later run.
    expect(stateLabel(orphan)).not.toBe(t("dev.stopped"));
  });

  test("a record without a state falls back to its exit code", () => {
    // The service that answered before this change did not send a state, and
    // the panel must still say something true about it.
    expect(devRunning(process({ exit_code: null }))).toBe(true);
    expect(devRunning(process({ exit_code: 0 }))).toBe(false);
    expect(stateLabel(process({ exit_code: 1, stopped: true }))).toBe(t("dev.stopped"));
  });

  test("a command that never started says why", () => {
    const failed = process({ state: "stopped", exit_code: 1, error: "npm: command not found" });
    expect(stateLabel(failed)).toBe(t("dev.failed"));
    expect(stateClass(failed)).toBe("text-destructive");
  });
});

describe("background command output", () => {
  test("stderr is ordinary output, not a process error", () => {
    expect(devLogLineClass("out")).toBe("text-foreground/80");
    expect(devLogLineClass("err")).toBe(devLogLineClass("out"));
  });
});

describe("stable background command rows", () => {
  test("keeps row identity by id while refreshing its process", () => {
    const a = process({ id: "dev_a" });
    const b = process({ id: "dev_b" });
    const update = createDevRowCache();
    const initial = update([a, b]);

    const refreshed = update([{ ...b }, { ...a, last_line: "ready" }]);
    expect(refreshed[0]).toBe(initial[1]);
    expect(refreshed[1]).toBe(initial[0]);
    expect(refreshed[1]!.process().last_line).toBe("ready");

    expect(update([{ ...b }])).toEqual([initial[1]]);
  });
});
