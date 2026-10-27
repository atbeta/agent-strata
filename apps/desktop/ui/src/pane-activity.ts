import { createSignal, untrack } from "solid-js";
import { sessionStatus, type SessionStatus } from "./session-status";

/**
 * Which sessions are running, as the panes showing them already know.
 *
 * The pane header used to read its status dot from one place: the session list
 * row. The list is the slowest status source in the app. `GET /sessions` is
 * refetched on a 200ms debounce that every burst of durable events pushes back,
 * and it says nothing about a message that is still being written. So a pane
 * watching a session it was not in drew a quiet grey dot on a conversation that
 * was visibly running — on a header twenty-eight pixels tall, which is exactly
 * where you look to find out whether to switch.
 *
 * The panes already know. Each one holds the view it just read, and `busy` on
 * that view came straight from the projection. So the view publishes what it
 * saw and the header reads that, with the list row behind it as the fallback
 * for every session no open pane is showing — which is all of them, for the
 * sidebar, and the sidebar already refetches on the window's own cadence.
 *
 * Only what a pane can prove, and only while it is mounted: a publish is
 * dropped on unmount, because a "running" left behind by a pane the reader just
 * closed is the same lie this file exists to remove.
 */
const [seen, setSeen] = createSignal<ReadonlyMap<string, boolean>>(new Map());

/**
 * Report what a pane's own view says about its session.
 *
 * Every read here is untracked, and that is load-bearing rather than tidy. Both
 * of these are called *from* effects, and each one has to look at the map to
 * decide whether it needs to write — a read-and-write store that the reader is
 * subscribed to is a store the reader invalidates itself. The first version did
 * exactly that: publish wrote, the write invalidated the effect that published,
 * the effect ran again and wrote again, and the pane stack-overflowed on mount.
 * A writer that leaves a subscription behind is not a writer, it is a loop.
 */
export function publishPaneBusy(sessionId: string, busy: boolean): void {
  untrack(() => {
    const cur = seen();
    if (cur.get(sessionId) === busy) return;
    const next = new Map(cur);
    next.set(sessionId, busy);
    setSeen(next);
  });
}

/** A pane stopped vouching for this session — its claim expires with the pane. */
export function clearPaneBusy(sessionId: string): void {
  untrack(() => {
    const cur = seen();
    if (!cur.has(sessionId)) return;
    const next = new Map(cur);
    next.delete(sessionId);
    setSeen(next);
  });
}

/**
 * The header's read of one pane's session.
 *
 * `busy` is OR-ed rather than replaced, so a pane that has not caught up yet
 * cannot talk the list out of a run the list can already see. The reverse — a
 * list row that has not caught up — is the case this fixes, and only the OR
 * direction is safe to resolve it in: a stale "busy" clears on the next probe,
 * a missing one would have waited for an event that may never come.
 */
export function paneStatus(
  sessionId: string,
  row: Parameters<typeof sessionStatus>[0] | undefined,
): SessionStatus | undefined {
  if (!row) return undefined;
  return sessionStatus({ ...row, busy: row.busy === true || seen().get(sessionId) === true });
}
