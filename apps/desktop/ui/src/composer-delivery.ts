import { restoreFailed, type Outgoing } from "./composer-input";
import { readQueuedText, writeQueuedText } from "./prompt-memory";
import { createRequestOwner, type RequestOwner } from "./request-owner";

export type DeliverySettlement = "success" | "failure" | "stale-success" | "stale-failure";

export function createComposerDelivery(deps: {
  readQueued?: typeof readQueuedText;
  writeQueued?: typeof writeQueuedText;
  owner?: RequestOwner;
  /**
   * Told when a message that never left is kept for a session.
   *
   * Without this the words were written to storage alone, which nothing on
   * screen reads: the queue looked empty, the message was invisible, and it
   * reappeared — all of it at once — the next time that session was opened.
   */
  onRetain?: (sessionId: string, out: Outgoing) => void;
} = {}) {
  const owner = deps.owner ?? createRequestOwner();
  const readQueued = deps.readQueued ?? readQueuedText;
  const writeQueued = deps.writeQueued ?? writeQueuedText;
  const failed = new Map<string, Outgoing[]>();

  const retain = (out: Outgoing, sessionId: string) => {
    const kept: Outgoing = {
      ...out,
      picked: [...out.picked],
      attachments: [...out.attachments],
      sessionId,
    };
    failed.set(sessionId, [...(failed.get(sessionId) ?? []), kept]);
    // Storage is the restart copy, not the record. It is appended to only when
    // the words are not already there: a message can be retained more than once
    // — every stale settlement retains it again — and appending blindly put
    // three copies of one sentence in the queue.
    if (out.text.trim()) {
      const queued = readQueued(sessionId);
      if (!queued.includes(out.text)) writeQueued(sessionId, [...queued, out.text]);
    }
    // And the caller is told, so the message can be shown where the reader will
    // see it instead of waiting in storage for the next open.
    deps.onRetain?.(sessionId, kept);
  };

  return {
    invalidate: owner.invalidate,

    async settle<T>(args: {
      sessionId: string;
      out: Outgoing;
      request: () => Promise<T>;
      onSuccess: (value: T) => void;
      onFailure: (error: unknown) => void;
    }): Promise<DeliverySettlement> {
      const token = owner.begin(args.sessionId);
      try {
        const value = await args.request();
        if (!owner.isCurrent(token)) return "stale-success";
        args.onSuccess(value);
        return "success";
      } catch (error) {
        if (!owner.isCurrent(token)) {
          retain(args.out, args.sessionId);
          return "stale-failure";
        }
        args.onFailure(error);
        return "failure";
      }
    },

    restore(sessionId: string, current: Outgoing): { draft: Outgoing; dropped: number } {
      const waiting = failed.get(sessionId);
      if (!waiting?.length) return { draft: current, dropped: 0 };
      failed.delete(sessionId);

      const queued = readQueued(sessionId);
      for (const out of waiting) {
        if (!out.text.trim()) continue;
        const at = queued.indexOf(out.text);
        if (at >= 0) queued.splice(at, 1);
      }
      writeQueued(sessionId, queued);

      let draft = current;
      let dropped = 0;
      for (const out of waiting) {
        const restored = restoreFailed(out, draft);
        draft = restored.draft;
        dropped += restored.dropped;
      }
      return { draft, dropped };
    },
  };
}
