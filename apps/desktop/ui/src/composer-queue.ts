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
    replace(items: T[]): void {
      if (items.length === 0) bySession.delete(activeSessionId);
      else bySession.set(activeSessionId, items);
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
