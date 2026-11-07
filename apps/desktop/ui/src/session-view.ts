import { createEffect, createMemo, createResource, createSignal, onCleanup, type Accessor } from "solid-js";
import { getJson, readViewTail, type SessionView } from "./api";
import { applyStreamingSnapshot, type StreamingSnapshot } from "./live";
import { settled } from "./resource";
import { createSessionViewLoader } from "./session-view-loader";
import { peekView, rememberView, TAIL_TURNS } from "./view-cache";

/**
 * The open session's view: the cached or cold load, the replay load, the
 * one-at-a-time refresh queue, the retry after a failed load, and the
 * streaming snapshots painted into it between refreshes.
 */
export function useSessionView(
  props: { id: string },
  deps: {
    replayPos: Accessor<number | null>;
    /** Created after this hook; read only when a snapshot arrives. */
    generating: () => boolean;
  },
) {
  const { replayPos } = deps;
  const opening = peekView(props.id);
  /** the background re-import that lands after the stored view is already up */
  const [importing, setImporting] = createSignal(true);
  // The files list key travels with the cached view so a warm open can leave
  // an unchanged list off the wire. forceFull skips the cache for one fetch.
  let filesKey: string | undefined = opening?.filesKey;
  let forceFull = false;
  let viewAlive = true;
  const viewLoader = createSessionViewLoader({
    readFull: (id, replayPos) => getJson<SessionView>(
      `/sessions/${encodeURIComponent(id)}/view${replayPos != null ? `?until_seq=${replayPos}` : ""}`,
    ),
    readTail: (id, key) => readViewTail(id, TAIL_TURNS, key),
    currentSessionId: () => props.id,
  });
  /** Consecutive automatic reload attempts after a failed one. */
  let retries = 0;
  onCleanup(() => {
    viewAlive = false;
    viewLoader.invalidate();
  });
  const [view, { refetch, mutate }] = createResource(
    () => ({ id: props.id, pos: replayPos() }),
    async (key: { id: string; pos: number | null }) => {
      viewLoader.invalidate();
      // Consume the flag even when this fetch is a replay, so leaving the
      // replay does not turn the next live open into a full download.
      const fullNow = forceFull;
      forceFull = false;
      if (key.pos !== null) {
        const replay = await viewLoader.loadFull(key.id, key.pos, () => {});
        return replay ?? peekView(props.id)?.view;
      }
      if (fullNow) {
        const full = await viewLoader.loadFull(key.id, null, (loaded, keyOf) => {
          filesKey = keyOf;
          rememberView(key.id, loaded, keyOf);
        });
        return full ?? peekView(props.id)?.view;
      }
      const hit = peekView(key.id);
      if (hit) {
        filesKey = hit.filesKey;
        return hit.view;
      }
      // Paint the tail, then replace it with the settled view. The preview is
      // not cached: storing it would make the next open a transcript with no history.
      const loaded = await viewLoader.loadCold(key.id, (preview, keyOf) => {
        filesKey = keyOf;
        mutate(preview);
      }, (full, keyOf) => {
        filesKey = keyOf;
        rememberView(key.id, full, keyOf);
      });
      return loaded ?? peekView(props.id)?.view;
    },
    opening ? { initialValue: opening.view } : undefined,
  );

  // A durable event during a reply only moves the last turns, and the whole
  // view of a long session is megabytes. A rebuild, a replay, or a tail that no
  // longer lines up goes back to the full view. Every view load goes through
  // here one at a time, and waits out a fetch already in flight: mutate() does
  // not cancel that fetch, so a tail laid down first would be replaced by the
  // older full view and leave the files list behind the key the server holds.
  let running: Promise<void> | undefined;
  let nextRefresh: "tail" | "full" | undefined;
  const waitWhileLoading = () =>
    new Promise<void>((resolve) => {
      const tick = () => {
        if (!viewAlive || !view.loading) resolve();
        else setTimeout(tick, 16);
      };
      tick();
    });
  /** settles once the view reflects this request, queued behind a running one or not */
  const refreshView = (full = false): Promise<void> => {
    if (replayPos() !== null) return Promise.resolve();
    if (running) {
      if (full || !nextRefresh) nextRefresh = full ? "full" : "tail";
      return running;
    }
    running = loadView(full);
    return running;
  };
  const loadView = async (full: boolean): Promise<void> => {
    let wantFull = full;
    try {
      for (;;) {
        if (!viewAlive || replayPos() !== null) return;
        if (view.loading) {
          if (wantFull) nextRefresh = "full";
          else if (!nextRefresh) nextRefresh = "tail";
          await waitWhileLoading();
          if (!viewAlive) return;
          if (!nextRefresh) break;
          wantFull = nextRefresh === "full";
          nextRefresh = undefined;
          continue;
        }
        const current = settled(view);
        if (wantFull || !current) {
          if (replayPos() !== null) return;
          filesKey = undefined;
          forceFull = true;
          await refetch();
          if (!viewAlive || replayPos() !== null) return;
        } else {
          const id = props.id;
          const outcome = await viewLoader.refreshTail(id, filesKey, () => settled(view) ?? current, (next, keyOf, changed) => {
            filesKey = keyOf;
            if (changed) mutate(next);
            rememberView(id, next, keyOf);
          });
          if (!viewAlive || replayPos() !== null || outcome === "stale") return;
          if (outcome === "full") {
            filesKey = undefined;
            wantFull = true;
            continue;
          }
        }
        if (!nextRefresh) break;
        wantFull = nextRefresh === "full";
        nextRefresh = undefined;
      }
    } catch {
      // the next event or the head poll asks again
    } finally {
      running = undefined;
      if (nextRefresh) {
        const again = nextRefresh === "full";
        nextRefresh = undefined;
        queueMicrotask(() => void refreshView(again));
      }
    }
  };

  /**
   * The view on screen. The resource keeps the previous session until the next
   * fetch resolves, and the route changes before that fetch does. A list painted
   * from the stale view is the wrong conversation at the wrong heights. The
   * cache already has the session the pane was showing, so use that until the
   * resource catches up.
   */
  const displayed = createMemo(() => {
    const v = settled(view);
    if (v?.session_id === props.id) return v;
    return peekView(props.id)?.view;
  });
  const viewReady = createMemo(() => {
    const id = props.id;
    return displayed()?.session_id === id;
  });

  /**
   * A failed load used to be permanent.
   *
   * The view resource only refetches when its source changes, so one request
   * that failed — the window opening before the service was listening, a proxy
   * restarting, a laptop waking — left the reader on that message for the rest
   * of the session with no way out but leaving. Try a few times on our own,
   * backing off so a service that is genuinely down is not hammered, then stop
   * and leave the button for them.
   */
  createEffect(() => {
    if (!view.error) {
      retries = 0;
      return;
    }
    if (retries >= 4) return;
    const wait = 500 * 2 ** retries++;
    const timer = setTimeout(() => {
      if (viewAlive) void refetch();
    }, wait);
    onCleanup(() => clearTimeout(timer));
  });

  // A warm open paints the cached view from the resource, then checks the
  // tail. Head equality is not enough while a reply is still streaming.
  createEffect(() => {
    const id = props.id;
    if (replayPos() !== null) return;
    if (!peekView(id)) return;
    queueMicrotask(() => {
      if (viewAlive && replayPos() === null) void refreshView(false);
    });
  });

  const paintSnapshot = (snap: StreamingSnapshot) => {
    if (replayPos() !== null) return;
    if (settled(view)?.busy !== true && !deps.generating()) return;
    mutate((v) => {
      if (!v) return v;
      const next = applyStreamingSnapshot(v, snap);
      const held = peekView(props.id);
      if (
        next !== v &&
        held &&
        next.turns.length >= held.view.turns.length &&
        next.turns[0]?.turn_id === held.view.turns[0]?.turn_id
      ) {
        rememberView(props.id, next);
      }
      return next;
    });
  };

  /** The reader asked again: the automatic attempts start over too. */
  const retryView = () => {
    retries = 0;
    void refetch();
  };
  /** A different session in this pane: paint its cached view now, if there is one. */
  const resetView = (id: string) => {
    const hit = peekView(id);
    filesKey = hit?.filesKey;
    forceFull = false;
    retries = 0;
    setImporting(!hit);
    if (hit) mutate(hit.view);
  };
  const endImport = () => setImporting(false);

  return { view, displayed, viewReady, importing, endImport, refreshView, paintSnapshot, retryView, resetView };
}
