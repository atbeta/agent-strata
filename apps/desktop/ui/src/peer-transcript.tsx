import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { getJson, readViewTail, type SessionView } from "./api";
import { settled } from "./resource";
import { planVisible } from "./plan-progress";
import { PlanStrip } from "./plan-strip";
import { TurnBlock } from "./transcript";
import { Virtual, type VirtualApi } from "./virtual";
import { PromptNavigator } from "./prompt-navigator";
import { promptAt, promptEntries } from "./prompt-outline";
import { applyStreamingSnapshot, mergeViewTail, runInProgress, type StreamingSnapshot } from "./live";
import {
  filesKeyOf,
  peekView,
  rememberView,
  tailMatches,
  TAIL_TURNS,
  viewFromTail,
} from "./view-cache";
import { t } from "./i18n";
import { contentW, paneScrollMemory } from "./session-chrome";
import { ContentSashes, LoadingTranscript } from "./content-sashes";
import type { SessionRowSummary } from "./pane-stage";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

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
  const memKey = () => `${props.paneId}:${props.sessionId}`;
  const savedScroll = paneScrollMemory.get(`${props.paneId}:${props.sessionId}`);
  const opening = peekView(props.sessionId);
  const [booting, setBooting] = createSignal(!opening);
  let filesKey: string | undefined = opening?.filesKey;
  let forceFull = false;
  let fetchGen = 0;
  let alive = true;
  onCleanup(() => {
    alive = false;
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

  createEffect(() => {
    if (booting() && (view.state === "ready" || view.state === "errored" || settled(view))) {
      setBooting(false);
    }
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
    onCleanup(() => {
      clearTimeout(timer);
      window.removeEventListener("strata-stream-event", onStream);
    });
  });

  const turns = () => settled(view)?.turns ?? [];
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
    paneScrollMemory.set(memKey(), { scrollTop: scroller?.scrollTop ?? 0, pinned: true });
  };

  return (
    <div class="relative flex min-h-0 flex-1 flex-col">
      <ContentSashes />
      <div
        ref={(el) => {
          scroller = el;
          queueMicrotask(() => {
            if (!el) return;
            setViewport(el.clientHeight);
            const remembered = paneScrollMemory.get(memKey());
            if (remembered && !remembered.pinned && remembered.scrollTop > 0) {
              el.scrollTop = remembered.scrollTop;
              setScrollTop(remembered.scrollTop);
            }
          });
        }}
        class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          const isPinned = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
          setScrollTop(el.scrollTop);
          setViewport(el.clientHeight);
          setPinned(isPinned);
          setActiveTurn(list?.indexAtTop() ?? 0);
          paneScrollMemory.set(memKey(), { scrollTop: el.scrollTop, pinned: isPinned });
        }}
      >
        <div
          class={
            showNav()
              ? "mx-auto w-full py-4 pl-11 pr-5"
              : "mx-auto w-full px-5 py-4"
          }
          style={{ "max-width": `${contentW()}px` }}
        >
          <Show when={!booting()} fallback={<LoadingTranscript />}>
            <Show
              when={turns().length > 0}
              fallback={
                <div class="flex justify-center">
                  <EmptyState
                    icon="spark"
                    title={t("session.empty")}
                    description={t("session.empty_hint")}
                    class="py-10"
                  />
                </div>
              }
            >
              <Virtual
                items={turns()}
                id={(turn) => turn.turn_id}
                estimate={100}
                gap={32}
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
