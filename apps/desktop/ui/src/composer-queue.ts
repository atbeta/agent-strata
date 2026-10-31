import { joinQueued, readDraft, takeQueuedText, writeQueuedText } from "./prompt-memory";

interface QueuedText {
  text: string;
  sessionId?: string;
}

export function createSessionQueues<T>(initialSessionId: string) {
  let activeSessionId = initialSessionId;
  const bySession = new Map<string, T[]>([[initialSessionId, []]]);

  return {
    current(): T[] {
      return bySession.get(activeSessionId) ?? [];
    },
    read(sessionId: string): T[] {
      return bySession.get(sessionId) ?? [];
    },
    replace(items: T[]): void {
      if (items.length === 0) bySession.delete(activeSessionId);
      else bySession.set(activeSessionId, items);
    },
    /** Write one session's queue without making it the active one. */
    replaceSession(sessionId: string, items: T[]): void {
      if (items.length === 0) bySession.delete(sessionId);
      else bySession.set(sessionId, items);
    },
    switch(sessionId: string): T[] {
      if (activeSessionId !== sessionId && !bySession.get(activeSessionId)?.length) {
        bySession.delete(activeSessionId);
      }
      activeSessionId = sessionId;
      return bySession.get(sessionId) ?? [];
    },
    snapshot(): Map<string, T[]> {
      return new Map(bySession);
    },
  };
}

/** Queued words for a session the composer is opening, folded into its draft once. */
export function restoreSessionDraft(
  sessionId: string,
  draft: string,
  deps: { take?: typeof takeQueuedText } = {},
): string {
  return joinQueued(draft, (deps.take ?? takeQueuedText)(sessionId));
}

export function restoreColdDraft(
  sessionId: string,
  deps: { read?: typeof readDraft; take?: typeof takeQueuedText } = {},
): string {
  return joinQueued((deps.read ?? readDraft)(sessionId), (deps.take ?? takeQueuedText)(sessionId));
}

export interface QueueGate {
  busy: boolean;
  held: boolean;
}

/**
 * Whether one session's queue may give up its head.
 *
 * The session on screen follows its own view: the list is the slow source,
 * and sending because the list has not caught up is how a return looks like
 * a surprise send. A session that is not on screen follows the list. No row
 * means we have not heard, so we do not send. An in-flight request or the
 * grace after it holds the next head so a queue does not leave all at once
 * before the run has had a chance to show up.
 */
export function queueGate(input: {
  visible: boolean;
  viewBusy: boolean;
  listedBusy: boolean | undefined;
  inflight: boolean;
  held: boolean;
  now: number;
  graceUntil?: number;
}): QueueGate | undefined {
  if (input.held) return { busy: true, held: true };
  // Grace and an in-flight request hold the next head on screen too. The
  // caller drops the grace once the view or the list has shown the run, so
  // this does not outlive it.
  const grace = input.graceUntil !== undefined && input.graceUntil > input.now;
  if (input.inflight || grace) return { busy: true, held: false };
  if (input.visible) return { busy: input.viewBusy, held: false };
  if (input.listedBusy === undefined) return undefined;
  return { busy: input.listedBusy, held: false };
}

/**
 * Heads that may leave now, taken off their own session's queue.
 *
 * One head per idle session. The session on screen is not special: a
 * follow-up typed in A leaves when A's run is idle, including while B is
 * what the reader is looking at. Replay holds only the session being
 * replayed. A head stamped for a different session stays put — it is not
 * this queue's to send.
 */
export function takeIdleHeads<T extends { sessionId?: string }>(
  queues: ReadonlyMap<string, readonly T[]>,
  gates: ReadonlyMap<string, QueueGate>,
  visible: { id: string; replaying: boolean },
): { queues: Map<string, T[]>; sending: { sessionId: string; item: T }[] } {
  const next = new Map<string, T[]>();
  const sending: { sessionId: string; item: T }[] = [];
  for (const [sessionId, items] of queues) {
    if (items.length === 0) continue;
    const head = items[0];
    const gate = gates.get(sessionId);
    const owned = head !== undefined && (head.sessionId === undefined || head.sessionId === sessionId);
    const ready =
      head !== undefined &&
      gate !== undefined &&
      !gate.busy &&
      !gate.held &&
      owned &&
      !(sessionId === visible.id && visible.replaying);
    if (!ready) {
      next.set(sessionId, [...items]);
      continue;
    }
    sending.push({ sessionId, item: head });
    const rest = items.slice(1);
    if (rest.length) next.set(sessionId, rest);
  }
  return { queues: next, sending };
}

/**
 * A queue the reader walked away from, as draft text.
 *
 * Closing the session screen is not a switch. Whatever was still queued
 * must not go out afterwards; the words come back to the draft, and the
 * stored queue is cleared so the next open does not send them either.
 * Attachments cannot be stored — the same limit as a restart.
 */
export function parkSessionQueues<T extends QueuedText>(
  queues: ReadonlyMap<string, readonly T[]>,
  io: {
    readDraft: (sessionId: string) => string;
    writeDraft: (sessionId: string, text: string) => void;
    writeQueued: (sessionId: string, texts: readonly string[]) => void;
  },
): void {
  const texts = new Map<string, string[]>();
  const ids = new Set<string>();
  for (const [sessionId, items] of queues) {
    ids.add(sessionId);
    for (const item of items) {
      const id = item.sessionId ?? sessionId;
      ids.add(id);
      if (!item.text.trim()) continue;
      const waiting = texts.get(id) ?? [];
      waiting.push(item.text);
      texts.set(id, waiting);
    }
  }
  for (const id of ids) {
    const waiting = texts.get(id) ?? [];
    if (waiting.length) io.writeDraft(id, joinQueued(io.readDraft(id), waiting));
    io.writeQueued(id, []);
  }
}

export function persistSessionQueues<T extends QueuedText>(
  queues: ReadonlyMap<string, readonly T[]>,
  previous: ReadonlySet<string>,
  writeQueued = writeQueuedText,
): Set<string> {
  const bySession = new Map<string, string[]>();
  for (const [sessionId, items] of queues) {
    for (const item of items) {
      const id = item.sessionId ?? sessionId;
      const texts = bySession.get(id) ?? [];
      if (item.text.trim()) texts.push(item.text);
      bySession.set(id, texts);
    }
  }
  for (const id of previous) {
    if (!bySession.has(id)) writeQueued(id, []);
  }
  for (const [id, texts] of bySession) writeQueued(id, texts);
  return new Set(bySession.keys());
}
