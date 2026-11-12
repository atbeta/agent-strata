import type { ViewPhase } from "./connection-status";

/**
 * What the window is allowed to say while it is starting.
 *
 * The app used to mount its real screens immediately: the first frame showed
 * "service unreachable" in the footer and sidebar because the sidecar had not
 * answered yet, then "connecting", then a sync the reader could not use. Each
 * of those was true for a moment and none of them was the whole situation.
 *
 * This turns startup into one surface with one stage. The screens mount only
 * once `ready` is true, so a slow launch waits visibly instead of claiming to
 * be usable and failing underneath.
 */
export type StartupHealth = "checking" | "up" | "down";

export type StartupStage =
  | "service"
  | "service-error"
  | "opencode"
  | "sessions"
  | "sessions-error"
  | "degraded"
  | "ready";

/**
 * A running sync is deliberately not one of these fields.
 *
 * It used to be: a stage of its own between the session list and the window.
 * That made the launch wait for an import the list does not need — `/sessions`
 * is read from the local store, so a first paint has everything a reader can
 * act on, and the sync only adds to it afterwards. Waiting for it meant the
 * window stayed on the launch surface for as long as the backend took to walk
 * its projects, and a slow or large checkout turned that into a black screen.
 *
 * The import is now background work the app shows off to the side (the 2px
 * line at the top of the content, and the footer's spinner), which is where a
 * reader can ignore it or watch it without being stopped by it.
 */
export interface StartupInput {
  health: StartupHealth;
  connections: ViewPhase;
  /** Whether the first session list has answered. */
  sessions: "loading" | "ready" | "error";
}

/**
 * The stage the launch is in.
 *
 * `opencode` covers both the first read (`pending`) and an address actually
 * being dialed (`attaching`). `unreachable` means `/connections` itself lost a
 * read even though `/health` answered; the hook rereads it, and treating it as
 * "no backend" would put a failure on screen for a request that is about to be
 * repeated.
 */
export function startupStage(input: StartupInput): StartupStage {
  if (input.health === "down") return "service-error";
  if (input.health === "checking") return "service";
  if (
    input.connections === "pending" ||
    input.connections === "attaching" ||
    input.connections === "unreachable"
  ) {
    return "opencode";
  }
  if (input.sessions === "error") return "sessions-error";
  if (input.sessions === "loading") return "sessions";
  if (
    input.connections === "failed" ||
    input.connections === "missing" ||
    input.connections === "idle"
  ) {
    return "degraded";
  }
  return "ready";
}

/** How far a launch has to be before the screen may offer a way past it. */
export const STARTUP_SLOW_MS = 10_000;
export const STARTUP_ENTER_AFTER_MS = 12_000;

/**
 * Whether the reader may enter while something is still running.
 *
 * A backend that is still being dialed is allowed after a while, but only when
 * the local list is already there — the alternative is an empty window that
 * cannot do anything. A launch that has not reached the session list yet has
 * nothing to show, so it does not offer the door.
 */
export function startupCanEnter(
  stage: StartupStage,
  input: { elapsedMs: number; sessionsReady: boolean },
): boolean {
  if (stage === "degraded") return true;
  if (stage !== "opencode") return false;
  return input.sessionsReady && input.elapsedMs >= STARTUP_ENTER_AFTER_MS;
}

export interface SyncProgress {
  done: number;
  total: number;
  /** At least one connection is still scanning and has no total yet. */
  indeterminate: boolean;
}

/** Sum the per-connection sync counters the stream reports. */
export function syncProgress(
  ticks: ReadonlyMap<string, { done: number; total: number }>,
): SyncProgress | undefined {
  if (ticks.size === 0) return undefined;
  let done = 0;
  let total = 0;
  let indeterminate = false;
  for (const tick of ticks.values()) {
    done += tick.done;
    total += tick.total;
    if (tick.total <= 0) indeterminate = true;
  }
  return { done, total, indeterminate };
}
