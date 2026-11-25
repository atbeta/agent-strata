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
  /**
   * Small values derived from a session's view, for every session rather than
   * the few whose events fit in `entries`: a pass over the whole store would
   * otherwise reread every session past the capacity each time it runs. One
   * slot per key: the list row and the usage buckets are asked of the same
   * sessions in turn, and a single slot had each evict the other.
   */
  private summaries = new Map<string, Map<string, { head: number; value: unknown }>>();

  constructor(
    private store: Store,
    private capacity = CAPACITY,
  ) {}

  private catchUp(sessionId: string, entry: Entry): void {
    const head = this.store.lastSeq(sessionId);
    if (head <= entry.head) return;
    entry.view = undefined;
    entry.body = undefined;
    while (entry.head < head) {
      const more = this.store.read({ session_id: sessionId, after_seq: entry.head, limit: 20_000 });
      if (more.length === 0) break;
      entry.events = entry.events.concat(more);
      entry.head = more.at(-1)!.seq;
    }
  }

  events(sessionId: string): Event[] {
    let entry = this.entries.get(sessionId);
    if (entry) {
      this.entries.delete(sessionId);
    } else {
      entry = { events: [], head: 0 };
    }
    this.catchUp(sessionId, entry);
    this.entries.set(sessionId, entry);
    while (this.entries.size > this.capacity) {
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
   * The settled view without touching the cache's order or admitting the
   * session. For passes over every session, which would otherwise evict the
   * sessions the sidebar is about to ask for.
   */
  peek(sessionId: string): SessionView {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      const cold: Entry = { events: [], head: 0 };
      this.catchUp(sessionId, cold);
      return projectSession(cold.events);
    }
    this.catchUp(sessionId, entry);
    entry.view ??= projectSession(entry.events);
    return entry.view;
  }

  /** `derive(view)` for this session, computed again only once the session moves or `key` changes. */
  summary<T>(sessionId: string, key: string, derive: (view: SessionView) => T): T {
    const head = this.store.lastSeq(sessionId);
    let slots = this.summaries.get(sessionId);
    const held = slots?.get(key);
    if (held && held.head === head) return held.value as T;
    const value = derive(this.peek(sessionId));
    if (!slots) this.summaries.set(sessionId, (slots = new Map()));
    // A session that moved has nothing worth keeping under its other keys.
    for (const [other, slot] of slots) if (slot.head !== head) slots.delete(other);
    slots.set(key, { head, value });
    return value;
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
    this.summaries.delete(sessionId);
  }
}

export { filesKeyOf } from "@agent-strata/projector";
