import type { EventInput, SessionRetry } from "@agent-strata/schema";
import { abortedDiagnostic, sessionDiagnostic, sourceTime, type SessionEventFactory } from "./model";
import { adoptSession, makeSessionEvent, type SessionState } from "./session";

export function markWork(s: SessionState): void {
  s.sawBusy = true;
  // A new run gets to announce its own ending, so the duplicate-idle guard
  // does not silence the one that follows.
  s.emittedIdle = false;
}

export function noteWork(
  s: SessionState,
  out: EventInput[],
  key: string,
  ev: SessionEventFactory<SessionState>,
): void {
  // Real output after a retry is recovery evidence. A bare busy frame still
  // gets no such authority, but this work must retire the retry even when the
  // session was already busy.
  if (s.sawBusy && s.retryKey === undefined) return;
  s.retryKey = undefined;
  s.retryAttempt = undefined;
  s.retryError = undefined;
  markWork(s);
  out.push(
    ev(
      s,
      "session.status",
      { state: "busy" },
      `opencode:${s.sessionID}:status:work:${key}`,
    ),
  );
}

export function noteRetry(
  s: SessionState,
  out: EventInput[],
  retry: SessionRetry,
  id: string,
  ev: SessionEventFactory<SessionState>,
  ts?: string,
): void {
  const current = {
    ...retry,
    ...(retry.error === undefined && s.retryAttempt === retry.attempt && s.retryError
      ? { error: s.retryError }
      : {}),
  };
  const key = Bun.hash(JSON.stringify(current)).toString(36);
  if (s.retryKey === key) return;
  markWork(s);
  s.retryKey = key;
  s.retryAttempt = current.attempt;
  s.retryError = current.error;
  s.compacting = undefined;
  s.summaryMsg = undefined;
  out.push(ev(s, "session.status", { state: "retry", retry: current }, id, ts));
}

export function syncCompacting(
  s: SessionState,
  out: EventInput[],
  info: { time?: { compacting?: number; updated?: number } },
  ev: SessionEventFactory<SessionState>,
): void {
  const active = info.time?.compacting;
  if (active !== undefined && Number.isFinite(active) && active > 0) {
    if (s.compacting === active) return;
    markWork(s);
    s.compacting = active;
    s.retryKey = undefined;
    s.retryAttempt = undefined;
    s.retryError = undefined;
    out.push(
      ev(
        s,
        "session.status",
        { state: "compacting" },
        `opencode:${s.sessionID}:compacting:${active}`,
        sourceTime(active),
      ),
    );
    return;
  }
  if (s.compacting === undefined) return;
  const finished = s.compacting;
  s.compacting = undefined;
  // A compaction message still open means the operation goes on: the session
  // clock ended but its assistant has not finished writing the summary yet.
  if (s.summaryMsg !== undefined) return;
  // Compaction finishing is not the session going idle: its assistant turn
  // may resume immediately, and the usual idle path owns that close.
  out.push(
    ev(
      s,
      "session.status",
      { state: "busy" },
      `opencode:${s.sessionID}:compacting:${finished}:done`,
      sourceTime(info.time?.updated),
    ),
  );
}

export function noteSessionError(
  s: SessionState,
  out: EventInput[],
  error: unknown,
  id: string,
  ev: SessionEventFactory<SessionState>,
  closeOpenMessages: (reason: "interrupted" | "stopped") => void,
): void {
  s.sawBusy = false;
  s.retryKey = undefined;
  s.retryAttempt = undefined;
  s.retryError = undefined;
  s.compacting = undefined;
  s.summaryMsg = undefined;
  s.awaiting = undefined;
  // A stop the reader asked for arrives as MessageAbortedError; it closes
  // the session without naming it a failure, and the reply it was cutting
  // off is marked stopped rather than interrupted.
  const diagnostic = sessionDiagnostic(error);
  closeOpenMessages(abortedDiagnostic(diagnostic) ? "stopped" : "interrupted");
  s.liveMsgs?.clear();
  out.push(
    ev(s, "session.error", { error: abortedDiagnostic(diagnostic) ? null : diagnostic }, id),
  );
}

export function reconcileIdleSessions(
  sessions: Map<string, SessionState>,
  idleSessionIDs: Iterable<string>,
  stillRunning: ((casfId: string) => { running: boolean; seq: number; ts?: string } | undefined) | undefined,
  closeOpenMessages: (s: SessionState, out: EventInput[]) => void,
  retireStreaming: (s: SessionState) => void,
): EventInput[] {
  const out: EventInput[] = [];
  for (const sessionID of idleSessionIDs) {
    const known = sessions.get(sessionID);
    // Memory first — this generation watched it run. Otherwise ask the store,
    // which is the only thing that remembers a run from before the restart.
    // It is asked under the id the store knows: `opencode:ses_…`, not the
    // bare id the backend uses.
    const stored = stillRunning?.(`opencode:${sessionID}`);
    const stale = known?.sawBusy === true || stored?.running === true;
    if (!stale) continue;
    const s = known ?? adoptSession(sessions, sessionID);
    s.sawBusy = false;
    s.emittedIdle = true;
    s.retryKey = undefined;
    s.retryAttempt = undefined;
    s.retryError = undefined;
    s.compacting = undefined;
    s.summaryMsg = undefined;
    s.awaiting = undefined;
    closeOpenMessages(s, out);
    s.liveMsgs?.clear();
    retireStreaming(s);
    // No stored position means nothing to dedupe against and no clock to
    // borrow; the plain id and the store's own clock are right there.
    const at = stored?.seq ? `:${stored.seq}` : "";
    out.push(
      makeSessionEvent(
        s,
        "session.status",
        { state: "idle" },
        `opencode:${sessionID}:reconcile:idle${at}`,
        stored?.ts,
      ),
    );
  }
  return out;
}
