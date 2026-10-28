import {
  createEffect,
  createMemo,
  createRenderEffect,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { getJson, readHead, readViewTail, type SessionView } from "./api";
import { settled } from "./resource";
import { createEntranceLedger } from "./entrance";
import { planVisible } from "./plan-progress";
import { PlanStrip } from "./plan-strip";
import { TurnBlock } from "./transcript";
import { Virtual, type VirtualApi } from "./virtual";
import { PromptNavigator } from "./prompt-navigator";
import { promptAt, promptEntries } from "./prompt-outline";
import { applyStreamingSnapshot, mergeViewTail, runInProgress, type StreamingSnapshot } from "./live";
import { isDevEvent } from "./sync-events";
import {
  filesKeyOf,
  peekView,
  rememberView,
  tailMatches,
  TAIL_TURNS,
  viewFromTail,
} from "./view-cache";
import { t } from "./i18n";
import { clearPaneBusy, publishPaneBusy } from "./pane-activity";
import { contentW, recallPaneScroll, rememberPaneScroll } from "./session-chrome";
import {
  ROW_ESTIMATE,
  ROW_GAP,
  layoutKey,
  placeReading,
  readRowHeights,
  rememberReading,
  writeRowHeight,
} from "./transcript-layout";
import { ContentSashes, LoadingTranscript } from "./content-sashes";
import { scrollCoalescer } from "./scroll-frame";
import type { SessionRowSummary } from "./pane-stage";
import { Button } from "@/components/ui/button";
import { SessionEmpty } from "./session-empty";

export type StreamEventPayload = {
  session_id?: string;
  type: string;
  data?: { state?: string; partial?: boolean };
};

/**
 * Lightweight live transcript for a non-focused pane in multiplex mode.
 * Shares the in-memory `view-cache` and receives SSE events forwarded from the
 * single `EventSource` owned by `SessionDetail`, so watching four panes in a
 * 2x2 grid still uses only one stream connection.
 */
export function PeerSessionTranscript(props: {
  sessionId: string;
  paneId: string;
  sessions: readonly SessionRowSummary[];
  onFocus: () => void;
  onOpenChild: (id: string) => void;
}) {
  const savedScroll = recallPaneScroll(props.paneId, props.sessionId);
  const opening = peekView(props.sessionId);
  const [booting, setBooting] = createSignal(!opening);
  let filesKey: string | undefined = opening?.filesKey;
  let forceFull = false;
  let fetchGen = 0;
  let alive = true;
  onCleanup(() => {
    alive = false;
    // This pane stops vouching for the session the moment it stops existing. A
    // claim outliving its pane is the exact failure `pane-activity` was written
    // to remove, reintroduced by the cleanup that was supposed to prevent it.
    clearPaneBusy(props.sessionId);
  });

  const [view, { refetch, mutate }] = createResource(
    () => props.sessionId,
    (id: string) => {
      const gen = ++fetchGen;
      const path = `/sessions/${encodeURIComponent(id)}/view`;
      const fullNow = forceFull;
      forceFull = false;
      if (fullNow) {
        return getJson<SessionView>(path).then((full) => {
          if (gen === fetchGen) {
            filesKey = filesKeyOf(full);
            rememberView(id, full, filesKey);
          }
          return full;
        });
      }
      const hit = peekView(id);
      if (hit) {
        if (hit.filesKey) filesKey = hit.filesKey;
        return Promise.resolve(hit.view);
      }
      return readViewTail(id, TAIL_TURNS).then(async (tail) => {
        if (gen !== fetchGen) return viewFromTail(tail);
        if (alive) {
          filesKey = tail.files_key;
          mutate(viewFromTail(tail));
        }
        const full = await getJson<SessionView>(path).catch(() => undefined);
        if (gen !== fetchGen || !full) return viewFromTail(tail);
        const keyOf = filesKeyOf(full);
        if (alive) filesKey = keyOf;
        rememberView(id, full, keyOf);
        return full;
      });
    },
    opening ? { initialValue: opening.view } : undefined,
  );

  // The header's dot is 28px tall and is where you look to decide whether to
  // switch to this pane, so it has to be right while the pane is not the one
  // being looked at. This view already carries the answer; publish it rather
  // than waiting for the session list to be refetched from behind.
  createEffect(() => {
    const v = settled(view);
    publishPaneBusy(props.sessionId, v?.session_id === props.sessionId && v.busy === true);
  });

  let running: Promise<void> | undefined;
  let nextRefresh: "tail" | "full" | undefined;
  const refreshPeerView = (full = false): Promise<void> => {
    if (running) {
      if (full || !nextRefresh) nextRefresh = full ? "full" : "tail";
      return running;
    }
    running = (async () => {
      let wantFull = full;
      try {
        for (;;) {
          if (!alive) return;
          const current = settled(view);
          if (wantFull || !current) {
            filesKey = undefined;
            forceFull = true;
            await refetch();
            if (!alive) return;
            const fullView = settled(view);
            if (fullView) {
              filesKey = filesKeyOf(fullView);
              rememberView(props.sessionId, fullView, filesKey);
            }
          } else {
            const tail = await readViewTail(props.sessionId, TAIL_TURNS, filesKey);
            if (!alive) return;
            const base = settled(view) ?? current;
            if (tailMatches(base, tail)) {
              filesKey = tail.files_key;
              rememberView(props.sessionId, base, filesKey);
            } else {
              const merged = mergeViewTail(base, tail);
              if (!merged) {
                filesKey = undefined;
                wantFull = true;
                continue;
              }
              filesKey = tail.files_key;
              mutate(merged);
              rememberView(props.sessionId, merged, filesKey);
            }
          }
          if (!nextRefresh) break;
          wantFull = nextRefresh === "full";
          nextRefresh = undefined;
        }
      } catch {
        // Retried on next stream event
      } finally {
        running = undefined;
      }
    })();
    return running;
  };

  let scroller: HTMLDivElement | undefined;
  let list: VirtualApi | undefined;
  const [scrollTop, setScrollTop] = createSignal(savedScroll?.scrollTop ?? 0);
  const [viewport, setViewport] = createSignal(0);
  const [pinned, setPinned] = createSignal(savedScroll?.pinned ?? true);
  const [activeTurn, setActiveTurn] = createSignal(0);

  onMount(() => {
    if (peekView(props.sessionId)) {
      queueMicrotask(() => {
        if (alive) void refreshPeerView(false);
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rebuilt = false;
    const onStream = (ev: Event) => {
      const evt = (ev as CustomEvent<StreamEventPayload>).detail;
      if (!evt || evt.session_id !== props.sessionId) return;
      // A dev server's output is not a turn. The focused pane still forwards it
      // to the window event the background panel listens on, and this pane has
      // nothing to say about it: reading it as activity made a running server
      // keep a peer view from ever settling.
      if (isDevEvent(evt.type)) return;
      if (evt.type === "turn.assistant" && evt.data?.partial === true) {
        // Same rule as the focused pane: a snapshot after idle is not a run.
        if (settled(view)?.busy !== true && row()?.busy !== true) return;
        const snap = evt.data as unknown as StreamingSnapshot;
        mutate((v) => {
          if (!v) return v;
          const next = applyStreamingSnapshot(v, snap);
          const held = peekView(props.sessionId);
          if (
            next !== v &&
            held &&
            next.turns.length >= held.view.turns.length &&
            next.turns[0]?.turn_id === held.view.turns[0]?.turn_id
          ) {
            rememberView(props.sessionId, next);
          }
          return next;
        });
        return;
      }
      // Permissions are not turns. The switch that governs them moved, and the
      // transcript did not, so this pane's view is still exactly right — and on
      // a long session the refetch it would otherwise trigger is the slowest
      // thing on screen.
      if (evt.type === "session.policy") return;
      if (evt.type === "session.rebuilt") rebuilt = true;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void refreshPeerView(rebuilt);
        rebuilt = false;
      }, 90);
    };
    window.addEventListener("strata-stream-event", onStream);

    // The floor under the forwarded stream.
    //
    // `/stream` is one connection, owned by the focused pane, and this pane's
    // only subscription to it is a window event that pane dispatches on its
    // behalf. Everything this peer knows arrives through that one hand-off, and
    // a hand-off has no way to report its own failure: a stream reconnecting, a
    // peer mounting while the focused pane's stream was down, one dropped
    // message — and from outside it is indistinguishable from an idle session.
    // The pane then stays frozen, because the event that would have corrected
    // it is also the event that is not arriving. That is the shape of the bug
    // this whole path was written to avoid: a latch with no independent exit.
    //
    // So the peer keeps the focused pane's own safety net, one layer down: ask
    // the head whether the session has moved since last time, and only pay for
    // a tail refresh when it has. An unchanged head returns before any view
    // work happens, so an idle peer costs one index probe and nothing else.
    let head = 0;
    const probe = setInterval(() => {
      void readHead(props.sessionId)
        .then((seq) => {
          if (seq === head) return;
          head = seq;
          void refreshPeerView(false);
        })
        .catch(() => {});
    }, 3_000);

    onCleanup(() => {
      clearInterval(probe);
      clearTimeout(timer);
      window.removeEventListener("strata-stream-event", onStream);
    });
  });

  /**
 * The column, and which of its turns may move in — the same ledger the main
 * transcript keeps, for the same reason: a split pane is still a reader, and
 * switching the session under it must not set the whole column moving.
 *
 * Keyed on the view's own session, not on the prop: the id changes before the
 * data does, and a ledger that reset on the id would baseline the new
 * conversation on the one being left.
 */
const entrance = createEntranceLedger();
const displayed = createMemo(() => {
  const v = settled(view);
  if (v?.session_id === props.sessionId) return v;
  return peekView(props.sessionId)?.view;
});
createEffect(() => {
  const ready = displayed()?.session_id === props.sessionId;
  if (booting() && (ready || view.state === "errored" || view.error)) setBooting(false);
});
const shown = createMemo(() => {
  const v = displayed();
  const t = v?.turns ?? [];
  return { turns: t, arriving: entrance.arriving(v?.session_id ?? "", t.map((x) => x.turn_id)) };
});
const turns = () => shown().turns;
  const entries = createMemo(() => promptEntries(turns()));
  const showNav = () => !booting() && entries().length >= 2;
  const activeEntry = () => (pinned() ? entries().at(-1) : promptAt(entries(), activeTurn()));
  const row = () => props.sessions.find((s) => s.summary.session_id === props.sessionId);
  const peerGenerating = () => runInProgress({ busy: row()?.busy || settled(view)?.busy });
  const needsInput = () => Boolean(row()?.needs_input);

  const childOf = (id: string) => {
    const r = props.sessions.find((s) => s.summary.session_id === id);
    if (!r) return undefined;
    return { title: r.title ?? "", status: r.status, busy: r.busy };
  };

  const jumpToLatest = () => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    setPinned(true);
    setActiveTurn(Math.max(0, turns().length - 1));
    const key = layoutKey(props.paneId, props.sessionId);
    rememberReading(key, { pinned: true });
    rememberPaneScroll(props.paneId, props.sessionId, {
      scrollTop: scroller?.scrollTop ?? 0,
      pinned: true,
    });
  };

  /**
   * Open on the layout this pane already measured. See the focused transcript:
   * the row and the heights have to be in place before the first paint, or the
   * column stacks on the 100px guess and then jumps.
   */
  let adoptedLayout = "";
  let heldTop = 0;
  let placing = false;
  const [placedTick, setPlacedTick] = createSignal(0);
  const placeScroller = (el: HTMLElement, top: number) => {
    if (el.scrollHeight < top) return false;
    if (el.scrollTop === top) return true;
    placing = true;
    el.scrollTop = top;
    placing = false;
    return true;
  };
  /**
   * One pass per frame, not one per scroll event. See `scroll-frame.ts`; the
   * transcript's handler writes four signals and reads layout on every call.
   */
  const onScrolled = scrollCoalescer((el) => {
    if (placing) return;
    const isPinned = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    setScrollTop(el.scrollTop);
    setViewport(el.clientHeight);
    setPinned(isPinned);
    setActiveTurn(list?.indexAtTop() ?? 0);
    const key = layoutKey(props.paneId, props.sessionId);
    rememberReading(key, list?.readingAtTop(isPinned) ?? { pinned: true });
    rememberPaneScroll(props.paneId, props.sessionId, {
      scrollTop: el.scrollTop,
      pinned: isPinned,
    });
  });
  createRenderEffect(() => {
    const paneId = props.paneId;
    const id = props.sessionId;
    const viewNow = displayed();
    if (viewNow?.session_id !== id) return;
    const key = layoutKey(paneId, id);
    if (key === adoptedLayout) return;
    adoptedLayout = key;
    const placed = placeReading({
      key,
      ids: turns().map((turn) => turn.turn_id),
      viewport: viewport(),
      fallback: recallPaneScroll(paneId, id),
    });
    heldTop = placed.scrollTop;
    setPinned(placed.pinned);
    setScrollTop(placed.scrollTop);
    setPlacedTick((n) => n + 1);
  });
  createEffect(() => {
    placedTick();
    const id = props.sessionId;
    const paneId = props.paneId;
    if (adoptedLayout !== layoutKey(paneId, id)) return;
    if (heldTop <= 0) return;
    let tries = 0;
    let frame = 0;
    const restore = () => {
      const el = scroller;
      if (!el || frame === 0 || ++tries > 120 || props.sessionId !== id || props.paneId !== paneId) {
        frame = 0;
        return;
      }
      if (!placeScroller(el, heldTop)) {
        frame = requestAnimationFrame(restore);
        return;
      }
      frame = 0;
      setScrollTop(heldTop);
    };
    frame = requestAnimationFrame(restore);
    onCleanup(() => {
      if (frame) cancelAnimationFrame(frame);
    });
  });

  return (
    <div class="relative flex min-h-0 flex-1 flex-col">
      <ContentSashes />
      <div
        ref={(el) => {
          scroller = el;
          if (!el) return;
          if (heldTop > 0) placeScroller(el, heldTop);
          /**
           * Measured, not guessed.
           *
           * `viewport` decides which rows are mounted: `Virtual` computes its
           * window from `props.viewport`, and its own `scrollerHeight` — which
           * it does observe — is only used to decide whether to re-pin to the
           * bottom. So this number is the whole of what a peer pane draws, and
           * it used to be read exactly once, in a microtask, on the assumption
           * that layout would be finished by then.
           *
           * It is not, for a pane that mounts while it is not the focused one.
           * A pane that takes focus gets measured a moment later by whatever
           * scrolls it, so it recovers and looks fine. A peer pane is mounted
           * precisely when nothing is going to scroll it, so the reading stands
           * at zero, `viewport` stays zero, and the window collapses to the
           * overscan rows — a conversation with tools and text in it, showing
           * blank. Waiting a frame longer would only move the race.
           *
           * Observed instead: every layout that changes this box updates it, and
           * the first callback lands when the browser has actually sized it.
           */
          const measure = () => setViewport(el.clientHeight);
          const ro = new ResizeObserver(measure);
          ro.observe(el);
          measure();
          onCleanup(() => ro.disconnect());
          // The restore itself is an effect below rather than part of this
          // callback: a peer pane is re-created per session, but a ref still
          // only runs on mount, and the point is to come back to a session
          // after having left it.
        }}
        class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        onScroll={onScrolled}
      >
        <div
          class={`${showNav() ? "mx-auto w-full px-11 py-4" : "mx-auto w-full px-5 py-4"}${
            turns().length === 0 ? " flex min-h-full flex-col" : ""
          }`}
          style={{
            "max-width": `calc(${contentW()}px + ${showNav() ? "5.5rem" : "2.5rem"})`,
          }}
        >
          <Show when={!booting()} fallback={<LoadingTranscript />}>
            <Show
              when={turns().length > 0}
              fallback={
                // Peer panes have no composer, so no key hints — just where
                // the session lives and that nobody has said anything yet.
                <div class="flex flex-1 items-center justify-center pb-[10vh]">
                  <SessionEmpty workspace={displayed()?.workspace} />
                </div>
              }
            >
              <Virtual
                items={turns()}
                id={(turn) => turn.turn_id}
                estimate={ROW_ESTIMATE}
                gap={ROW_GAP}
                layoutKey={layoutKey(props.paneId, props.sessionId)}
                seed={readRowHeights(layoutKey(props.paneId, props.sessionId))}
                follow={pinned()}
                onHeight={(key, turnId, height) => writeRowHeight(key, turnId, height)}
                scrollTop={scrollTop()}
                viewport={viewport()}
                scroller={() => scroller}
                api={(a) => {
                  list = a;
                  setActiveTurn(a.indexAtTop());
                }}
              >
                {(turn) => (
                  <div data-turn-id={turn().turn_id}>
                    <TurnBlock
                      turn={turn()}
                      entering={() => shown().arriving.has(turn().turn_id)}
                      live={() =>
                        peerGenerating() && turns().at(-1)?.turn_id === turn().turn_id
                      }
                      awaiting={() => false}
                      childOf={childOf}
                      onOpenChild={props.onOpenChild}
                    />
                  </div>
                )}
              </Virtual>
            </Show>
          </Show>
        </div>
      </div>

      <Show when={showNav()}>
        <PromptNavigator
          entries={entries()}
          activeId={activeEntry()?.turnId}
          onSelect={(turnId) => {
            const idx = turns().findIndex((x) => x.turn_id === turnId);
            if (idx >= 0) {
              setPinned(false);
              list?.scrollToIndex(idx, "start");
              setActiveTurn(idx);
            }
          }}
        />
      </Show>

      <Show when={!booting() && !pinned() && turns().length > 0}>
        <Button
          type="button"
          variant="quiet"
          size="xs"
          class="surface-popover absolute bottom-10 left-1/2 z-20 h-auto -translate-x-1/2 rounded-full border border-border bg-popover px-3 py-1 shadow-md"
          onClick={jumpToLatest}
        >
          {t("nav.latest")}
        </Button>
      </Show>

      <Show when={settled(view)?.plan && planVisible(settled(view)!.plan, peerGenerating())}>
        <div class="shrink-0 border-t border-border px-3 py-1.5">
          <PlanStrip
            sessionId={props.sessionId}
            plan={settled(view)!.plan!}
            generating={peerGenerating()}
          />
        </div>
      </Show>

      <Show when={needsInput()}>
        <div
          class="shrink-0 border-t border-border bg-secondary/40 px-3 py-1.5"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Button
            type="button"
            variant="outline"
            size="xs"
            class="w-full justify-start gap-2 border-status-pending/40 bg-status-pending/10 text-foreground hover:bg-status-pending/20"
            onClick={() => props.onFocus()}
          >
            <span class="size-1.5 shrink-0 rounded-full bg-status-pending" />
            <span class="truncate text-xs">{t("pane.needs_input.banner")}</span>
          </Button>
        </div>
      </Show>
    </div>
  );
}
