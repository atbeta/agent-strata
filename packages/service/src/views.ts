import { projectSession, type SessionView } from "@agent-strata/projector";
import type { Event } from "@agent-strata/schema";
import type { Store } from "@agent-strata/store";

// at least the sidebar's page of sessions, or every list request rereads them all
const CAPACITY = 256;

interface Entry {
  events: Event[];
  head: number;
  view?: SessionView;
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
      if (head > entry.head) {
        const more = this.store.read({ session_id: sessionId, after_seq: entry.head, limit: 20_000 });
        entry.events = entry.events.concat(more);
        entry.head = more.at(-1)?.seq ?? entry.head;
        entry.view = undefined;
      }
    } else {
      const events = this.store.read({ session_id: sessionId, limit: 20_000 });
      entry = { events, head: events.at(-1)?.seq ?? 0 };
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

  /** a rebuild deletes rows, which an incremental read cannot see */
  drop(sessionId: string): void {
    this.entries.delete(sessionId);
  }
}
