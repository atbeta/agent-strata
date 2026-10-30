import { projectSession, type SessionView } from "@agent-strata/projector";
import type { Event } from "@agent-strata/schema";
import type { Store } from "@agent-strata/store";

// at least the sidebar's page of sessions, or every list request rereads them all
const CAPACITY = 256;

interface Entry {
  events: Event[];
  head: number;
  view?: SessionView;
  /** JSON of the settled view. Cleared with the view, so a live partial never lands here. */
  body?: string;
}

/** Each session's stored events and projection, kept until the session moves. */
export class ViewCache {
  private entries = new Map<string, Entry>();

  constructor(private store: Store) {}

  events(sessionId: string): Event[] {
    const head = this.store.lastSeq(sessionId);
    let entry = this.entries.get(sessionId);
    if (entry) {
      this.entries.delete(sessionId);
    } else {
      entry = { events: [], head: 0 };
    }
    if (head > entry.head) {
      entry.view = undefined;
      entry.body = undefined;
      while (entry.head < head) {
        const more = this.store.read({ session_id: sessionId, after_seq: entry.head, limit: 20_000 });
        if (more.length === 0) break;
        entry.events = entry.events.concat(more);
        entry.head = more.at(-1)!.seq;
      }
    }
    this.entries.set(sessionId, entry);
    while (this.entries.size > CAPACITY) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return entry.events;
  }

  view(sessionId: string): SessionView {
    const events = this.events(sessionId);
    const entry = this.entries.get(sessionId)!;
    entry.view ??= projectSession(events);
    return entry.view;
  }

  /**
   * The settled view, already serialized. The object cache skips projection;
   * this skips turning a multi-megabyte view into a string on every open.
   * Callers that overlay live events must not use it — those bytes are the
   * stored record only, and they are dropped as soon as the head moves.
   */
  viewBody(sessionId: string): string {
    const view = this.view(sessionId);
    const entry = this.entries.get(sessionId)!;
    entry.body ??= JSON.stringify(view);
    return entry.body;
  }

  /** a rebuild deletes rows, which an incremental read cannot see */
  drop(sessionId: string): void {
    this.entries.delete(sessionId);
  }
}

export { filesKeyOf } from "@agent-strata/projector";
