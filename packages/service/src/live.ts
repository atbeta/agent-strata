import { parseEvent, type Event, type EventInput } from "@agent-strata/schema";

/**
 * Assistant messages still being written. Readers see them; the log never
 * does. The completed message, or the session going idle, retires them.
 */
export class LiveOverlay {
  private bySession = new Map<string, Map<string, EventInput>>();
  /** bumps on every change, for callers that cache what they derive from it */
  version = 0;

  put(e: EventInput): boolean {
    if (e.type !== "turn.assistant" || !e.data.msg_id) return false;
    let messages = this.bySession.get(e.session_id);
    if (!messages) {
      messages = new Map();
      this.bySession.set(e.session_id, messages);
    }
    messages.set(e.data.msg_id, e);
    this.version++;
    return true;
  }

  settle(e: Event): void {
    const messages = this.bySession.get(e.session_id);
    if (!messages) return;
    const ends =
      (e.type === "session.status" && e.data.state === "idle") ||
      e.type === "session.ended" ||
      e.type === "session.deleted";
    if (ends) {
      this.bySession.delete(e.session_id);
      this.version++;
      return;
    }
    if (e.type === "turn.assistant" && e.data.msg_id && e.data.partial !== true) {
      if (messages.delete(e.data.msg_id)) this.version++;
      if (messages.size === 0) this.bySession.delete(e.session_id);
    }
  }

  has(sessionId: string): boolean {
    return (this.bySession.get(sessionId)?.size ?? 0) > 0;
  }

  /** The live messages numbered after the stored ones, so a projection applies them last. */
  events(sessionId: string, afterSeq: number): Event[] {
    const messages = this.bySession.get(sessionId);
    if (!messages) return [];
    return [...messages.values()].map((e, i) =>
      parseEvent({ ...e, id: e.id ?? `live:${sessionId}:${i}`, seq: afterSeq + 1 + i }),
    );
  }
}
