import type { MessageKey } from "./locales/zh";

/**
 * What a session is doing, and how loudly the list should say it.
 *
 * `GET /sessions` has been returning three independent fields all along —
 * `status` (the last `session.ended` reason: active / completed / cancelled /
 * error), `busy` (the last `session.status`, live) and `needs_input` (a live
 * pending permission or question) — and the lists were reading two of them.
 * `status` had no reader at all, which is why a session that ended in an error
 * was indistinguishable from one that ended normally: both drew nothing.
 *
 * This is the one place that decides which of the three wins.
 */
export type SessionStatusKind =
  | "needs-input"
  | "running"
  | "failed"
  | "stopped"
  | "done"
  | "idle";

/** The palette a state draws with, resolved once so no caller picks a colour. */
export interface StatusTone {
  /** The row dot. */
  dot: string;
  /** Text colour for the badge word. */
  text: string;
  /** Badge background. */
  chip: string;
}

export interface SessionStatus {
  kind: SessionStatusKind;
  /** The word — used by the badge, and by anything that needs the name. */
  label: MessageKey;
  tone: StatusTone;
  /**
   * Whether the word earns the row width. Only the two states that want
   * something from the reader get one.
   */
  badge: boolean;
  /** Whether the dot breathes. Only while work is actually happening. */
  pulse: boolean;
}

const PERMISSION: StatusTone = {
  dot: "bg-event-permission",
  text: "text-event-permission",
  chip: "bg-event-permission/15",
};
const ACTIVE: StatusTone = {
  dot: "bg-status-active",
  text: "text-status-active",
  chip: "bg-status-active/15",
};
const ERROR: StatusTone = {
  dot: "bg-status-error",
  text: "text-status-error",
  chip: "bg-status-error/15",
};
const MUTED: StatusTone = {
  dot: "bg-status-pending",
  text: "text-muted-foreground",
  chip: "bg-secondary/70",
};

/**
 * The badge costs more than a dot, so only two states pay for one:
 *
 *   - needs input, because the reader is the one holding the turn up;
 *   - failed, because it ended and nothing else on screen would say so.
 *
 * Running says itself with a breathing dot. Stopped, done and idle draw the
 * same quiet dot and no word: a row with nothing in front of the title has no
 * status at all, which on a list of finished sessions is every row. The word
 * stays for a screen reader.
 */
export function sessionStatus(row: {
  status?: string;
  busy?: boolean;
  needs_input?: boolean;
}): SessionStatus {
  // Waiting outranks running: a session that has stopped for a decision is the
  // one going nowhere, and a session that is both is waiting, not merely busy.
  if (row.needs_input) {
    return { kind: "needs-input", label: "session.status.needsInput", tone: PERMISSION, badge: true, pulse: false };
  }
  // `busy` before `status`: the projector clears `busy` on `session.ended`, so
  // an error from an earlier turn cannot outrank work happening right now.
  if (row.busy) {
    return { kind: "running", label: "session.status.running", tone: ACTIVE, badge: false, pulse: true };
  }
  switch (row.status) {
    case "error":
      return { kind: "failed", label: "session.status.failed", tone: ERROR, badge: true, pulse: false };
    case "cancelled":
      return { kind: "stopped", label: "session.status.stopped", tone: MUTED, badge: false, pulse: false };
    case "completed":
      return { kind: "done", label: "session.status.done", tone: MUTED, badge: false, pulse: false };
    default:
      return { kind: "idle", label: "session.status.idle", tone: MUTED, badge: false, pulse: false };
  }
}

/** Every state draws a dot. The quiet ones are how an idle row is told from a gap. */
export function showsDot(_s: SessionStatus): boolean {
  return true;
}
