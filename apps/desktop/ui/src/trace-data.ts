/**
 * Paged, incremental loading for the trace.
 *
 * A session's events come back in pages ordered by seq; the strip used to
 * stop at the first 2,000 and stay frozen while the session moved. Two fixes
 * live here: `after_seq` pages until a short page says the log is done, and a
 * bump in the session's head seq fetches only what landed since — while an
 * epoch bump (a rebuild re-sequences everything) throws the list away and
 * starts over.
 */
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { getJson } from "./api";
import { TRACE_TYPES, traceBlocks, type TraceBlock, type TraceSourceEvent } from "./trace-model";

const PAGE = 5_000;
const TYPES = `types=${TRACE_TYPES.join(",")}`;

/**
 * Append a page of newer events. Only events past the loaded tail survive:
 * pages overlap on purpose (the cursor is `> last`, and a rebuild's fresh
 * seqs would otherwise double the tail).
 */
export function mergeTraceEvents(
  prev: TraceSourceEvent[],
  next: TraceSourceEvent[],
): { events: TraceSourceEvent[]; appended: number } {
  if (!next.length) return { events: prev, appended: 0 };
  // Pages arrive seq-ascending, so the tail is the max — a spread of a long
  // session would blow the argument limit in WebKit anyway.
  let last = 0;
  for (const e of prev) if (e.seq > last) last = e.seq;
  const fresh = next.filter((e) => e.seq > last);
  if (!fresh.length) return { events: prev, appended: 0 };
  return { events: [...prev, ...fresh], appended: fresh.length };
}

export function createTraceData(opts: {
  sessionId: () => string;
  /** newest stored seq — bumps when the session advances */
  head: () => number | undefined;
  /** bumped on rebuild/import: forces a full reload */
  epoch: () => number;
  /** the trace panel is open — nothing is fetched while it is not */
  enabled: () => boolean;
}): {
  blocks: () => TraceBlock[];
  loading: () => boolean;
  error: () => unknown;
} {
  const [events, setEvents] = createSignal<TraceSourceEvent[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<unknown>(undefined);
  /** how far the loaded list reaches — the cursor the next page starts from */
  let lastSeq = 0;
  /** in-flight generation: a session/epoch switch discards late answers */
  let gen = 0;
  /** one incremental fetch at a time */
  let tailFetching = false;
  /** the initial page run has finished — a session with no trace events yet
   *  still takes new ones */
  let loaded = false;

  const fetchPage = (id: string, after: number) =>
    getJson<{ events: TraceSourceEvent[] }>(
      `/events?session_id=${encodeURIComponent(id)}&order=asc&limit=${PAGE}&after_seq=${after}&${TYPES}`,
    ).then((r) => r.events);

  const reload = async (id: string, g: number) => {
    setLoading(true);
    setError(undefined);
    // Read the head before paging: events landing during the page run stay
    // ahead of lastSeq, so the tail fetch picks them up rather than skipping
    // them forever.
    const headAtStart = untrack(opts.head) ?? 0;
    try {
      let after = 0;
      let all: TraceSourceEvent[] = [];
      for (;;) {
        const page = await fetchPage(id, after);
        if (g !== gen) return;
        if (!page.length) break;
        all = all.concat(page);
        after = page[page.length - 1]!.seq;
        if (page.length < PAGE) break;
      }
      setEvents(all);
      // A short page means the log is done: whatever the head still counts
      // past this belongs to event types the trace does not draw.
      lastSeq = Math.max(after, headAtStart);
    } catch (e) {
      if (g === gen) setError(e);
    } finally {
      if (g === gen) {
        setLoading(false);
        loaded = true;
      }
    }
  };

  // Full reload: on enable, on session switch, on epoch bump.
  createEffect(() => {
    const id = opts.sessionId();
    opts.epoch();
    if (!opts.enabled()) {
      gen++;
      lastSeq = 0;
      loaded = false;
      setEvents([]);
      setLoading(false);
      return;
    }
    const g = ++gen;
    lastSeq = 0;
    loaded = false;
    void reload(id, g);
  });

  // Incremental tail: the head probe advanced past what we hold.
  createEffect(() => {
    const head = opts.head();
    if (!opts.enabled() || loading() || head === undefined || head <= 0) return;
    if (!loaded || head <= lastSeq || tailFetching) return;
    const g = gen;
    const id = opts.sessionId();
    tailFetching = true;
    void (async () => {
      try {
        // Keep paging while the head stays ahead — a burst that lands mid-
        // fetch would otherwise wait for something else to wake this up.
        for (;;) {
          let after = lastSeq;
          // Read before fetching, as in reload: a head read afterwards could
          // count events that landed after the page was cut.
          const headBefore = untrack(opts.head) ?? 0;
          for (;;) {
            const page = await fetchPage(id, after);
            if (g !== gen) return;
            if (!page.length) break;
            setEvents((cur) => mergeTraceEvents(cur, page).events);
            after = page[page.length - 1]!.seq;
            if (page.length < PAGE) break;
          }
          // Skip over non-trace events the head counts but we never draw.
          lastSeq = Math.max(after, headBefore);
          if ((untrack(opts.head) ?? 0) <= lastSeq) break;
        }
      } catch {
        // the next head bump asks again
      } finally {
        tailFetching = false;
      }
    })();
  });

  const blocks = createMemo(() => traceBlocks(events()));
  return { blocks, loading, error };
}
