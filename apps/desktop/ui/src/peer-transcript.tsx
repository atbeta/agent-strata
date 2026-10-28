import {
  createEffect,
  createMemo,
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
import { TranscriptView } from "./transcript-view";
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
  const row = () => props.sessions.find((s) => s.summary.session_id === props.sessionId);
  const peerGenerating = () => runInProgress({ busy: row()?.busy || settled(view)?.busy });
  const needsInput = () => Boolean(row()?.needs_input);

  const childOf = (id: string) => {
    const r = props.sessions.find((s) => s.summary.session_id === id);
    if (!r) return undefined;
    return { title: r.title ?? "", status: r.status, busy: r.busy };
  };

  return (
    <>
    <TranscriptView
      paneId={props.paneId}
      sessionId={displayed()?.session_id ?? props.sessionId}
      turns={turns()}
      ready={!booting()}
      nav={!booting()}
      class="min-h-0"
      empty={
        // Peer panes have no composer, so no key hints — just where
        // the session lives and that nobody has said anything yet.
        <div class="flex flex-1 items-center justify-center pb-[10vh]">
          <SessionEmpty workspace={displayed()?.workspace} />
        </div>
      }
      renderTurn={(turn) => (
        <TurnBlock
          turn={turn()}
          entering={() => shown().arriving.has(turn().turn_id)}
          live={() => peerGenerating() && turns().at(-1)?.turn_id === turn().turn_id}
          awaiting={() => false}
          childOf={childOf}
          onOpenChild={props.onOpenChild}
        />
      )}
    />

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
    </>
  );
}
