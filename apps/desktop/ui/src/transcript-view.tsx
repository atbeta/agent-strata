/**
 * The transcript itself, shared by the focused pane and every peer pane.
 *
 * Both panes used to build this whole column for themselves — the scroller,
 * the windowed list, the prompt rail, the way back to the latest turn — and
 * they did not build it the same way, which is how a reader's place got lost
 * between them. There is one of each here now.
 *
 * Everything that decides where the reader stands is rebuilt for each
 * (pane, session): a fresh row layout and a fresh scroll owner. Nothing about
 * the scroll position survives a switch — a session opened in a pane carries
 * no scroll state over from the one it replaces, which is the failure where a
 * pane that had been scrolled up opened the next conversation at its head.
 * What does survive is the remembered reading for that pair, and the row
 * heights already measured there.
 */
import { createEffect, createMemo, createSignal, Show, untrack, type JSX } from "solid-js";
import type { ContentBlock, Turn } from "./api";
import { Virtual } from "./virtual";
import { warmMarkdown } from "./md";
import { readThinkingOpen } from "./thinking";
import { createRowLayout } from "./row-layout";
import { createScrollOwner } from "./scroll-owner";
import {
  ROW_ESTIMATE,
  ROW_GAP,
  layoutKey,
  readDisclosure,
  readRowHeights,
  recallReading,
  rememberReading,
  writeRowHeight,
} from "./transcript-layout";
import { scrollCoalescer } from "./scroll-frame";
import { DisclosureContext } from "./disclosure";
import { ContentSashes, LoadingTranscript } from "./content-sashes";
import { PromptNavigator } from "./prompt-navigator";
import { promptAt, promptEntries, type PromptEntry } from "./prompt-outline";
import { contentW } from "./session-chrome";
import { Tip } from "./tip";
import { Button } from "@/components/ui/button";
import { Icon } from "./icons";
import { t } from "./i18n";
import { createIds } from "./turn-ids";
import { estimateSegmentHeight, turnSegments, type TurnPart, type TurnSegment } from "./turn-segments";
import { explain, fadeSignal } from "./errors";
import { PathActions, resolveTarget, revealResolved, type PathApi } from "./path-link";

export interface TranscriptApi {
  jumpTo: (turnId: string, align?: "start" | "center") => void;
  jumpToIndex: (index: number, align?: "start" | "center") => void;
  toLatest: () => void;
}

/**
 * A path that could not be opened, and where to say so.
 *
 * The position is measured from the column, not the window, so the notice
 * follows the transcript it belongs to. `centered` is the fallback for a
 * failure with no anchor to point at.
 */
type PathNotice = { text: string; x: number; y: number; centered: boolean };

/**
 * How long a failed path stays on screen.
 *
 * Shorter than the general action line: the notice answers one click, and
 * the reader is still looking at the path they clicked. Long enough to read a
 * sentence, short enough that it is not there when they look again.
 */
const NOTICE_MS = 4_000;

export function TranscriptView(props: {
  paneId: string;
  sessionId: string;
  turns: readonly Turn[];
  /** false → <LoadingTranscript /> */
  ready: boolean;
  /** Shown when ready and turns.length === 0. */
  empty: JSX.Element;
  /** Outline allowed — it still needs >= 2 prompts. */
  nav: boolean;
  /** "Back to latest" button allowed (default true). */
  latest?: boolean;
  /** The wrapper's layout classes, which differ between the two panes. */
  class?: string;
  /** One turn segment; the <div data-turn-id data-row-id> wrapper is added here. */
  renderTurn: (turn: () => Turn, part: () => TurnPart) => JSX.Element;
  /** Receives the imperative handle once, and again on each remount. */
  api?: (a: TranscriptApi) => void;
  /**
   * Scroll gesture and whether the reader is on the tail. The session uses
   * this to hold transcript writes until the gesture ends.
   */
  onScrollGate?: (gate: { gesturing: boolean; following: boolean }) => void;
  /** The session's workspace — anchors relative paths in the transcript. */
  workspace?: () => string | undefined;
  /** Open a workspace-relative path in the session's right rail. Without this
   *  there is nothing to open into, and paths stay plain text. */
  onOpenPath?: (rel: string) => void;
}): JSX.Element {
  /**
   * What a path in this transcript can do. Nothing to open into without
   * onOpenPath — a peer pane gets no rail — so there is no context at all and
   * the paths stay text rather than dead links.
   */
  const [pathErr, setPathErr] = fadeSignal<PathNotice | undefined>(undefined, NOTICE_MS);
  let column: HTMLDivElement | undefined;

  /**
   * Whether the reader is scrolling right now.
   *
   * The scroll owner knows — it is the thing that times the gesture — but it
   * lives inside the transcript, and the path actions sit above it. This
   * mirrors it, so "not while the reader scrolls" is one question with one
   * answer.
   */
  const [gesturing, setGesturing] = createSignal(false);
  /**
   * Work that waits for the reader to stop scrolling.
   *
   * The listeners stay on the list: every gesture that ends sends them
   * through again, because a path that was off screen a moment ago may be on
   * screen now.
   */
  const waiting: (() => void)[] = [];

  /**
   * Where a failed path lands.
   *
   * The notice follows the click: a reader who clicked a path wants to know
   * about *that* path, and a line at the bottom of a column they have
   * scrolled away from answers a question they are no longer looking at.
   */
  const notice = (text: string, anchor?: HTMLElement) => {
    const base = column?.getBoundingClientRect();
    const at = anchor?.getBoundingClientRect();
    if (!base || !at) {
      setPathErr({ text, x: 0, y: 0, centered: true });
      return;
    }
    // Kept inside the column: a notice that hangs off the edge is a notice
    // the reader cannot read.
    const x = Math.min(
      Math.max(at.left + at.width / 2 - base.left, 90),
      Math.max(base.width - 90, 90),
    );
    const y = Math.max(at.top - base.top, 24);
    setPathErr({ text, x, y, centered: false });
  };

  const pathApi: PathApi | undefined = props.onOpenPath
    ? {
        open: (raw, anchor) => {
          const target = resolveTarget(raw, props.workspace?.());
          if (target.rel !== undefined) {
            props.onOpenPath!(target.rel);
            return;
          }
          if (target.abs !== undefined) {
            void revealResolved(raw, props.workspace?.()).catch((e) => notice(explain(e), anchor));
            return;
          }
          notice(t("path.missing"), anchor);
        },
        revealable: (raw) => resolveTarget(raw, props.workspace?.()).abs !== undefined,
        reveal: (raw) => {
          void revealResolved(raw, props.workspace?.()).catch((e) => notice(explain(e)));
        },
        workspace: () => props.workspace?.(),
        // A path is only asked about when the reader is not moving the
        // column: a row that mounts mid-scroll is not worth a round-trip, and
        // the answer would land while the row is off screen.
        blocked: () => gesturing(),
        onReady: (fn) => {
          waiting.push(fn);
        },
      }
    : undefined;

  return (
    <div class={`relative flex flex-1 flex-col ${props.class ?? ""}`} ref={(el) => (column = el)}>
      <Show when={layoutKey(props.paneId, props.sessionId)} keyed>
        {(key) => {
          const entries = createMemo<PromptEntry[]>((prev) => promptEntries(props.turns, prev));
          const showNav = () => props.nav && entries().length >= 2;
          // Rows are turn segments: a turn of hundreds of messages is mounted
          // as many small rows instead of one it takes hundreds of ms to build.
          const segments = createMemo<TurnSegment[]>((prev) => turnSegments(props.turns, prev));
          const ids = createIds(segments, (s) => s.id);
          const layout = createRowLayout({
            ids,
            estimate: ROW_ESTIMATE,
            estimates: () => estimates(),
            gap: ROW_GAP,
            // A turn's later segments continue the row above them; the turn
            // gap is between turns, not every SEGMENT_MESSAGES messages.
            joined: (i) => (segments()[i + 1]?.part ?? 0) > 0,
            seed: readRowHeights(key),
            onHeight: (id, height) => writeRowHeight(key, id, height),
          });
          /**
           * How tall each row is expected to be, for the rows not yet measured.
           *
           * The same map while the numbers hold: a new one rebuilds the prefix
           * sum and re-runs the owner's write. A measured row is left out — its
           * estimate is never read, and the row a reply streams into is measured
           * from its first frame and grows on every tick.
           */
          const estimates = createMemo<ReadonlyMap<string, number>>((prev) => {
            let same = prev !== undefined;
            let count = 0;
            for (const seg of segments()) {
              if (layout.isMeasured(seg.id)) continue;
              count += 1;
              if (same && prev!.get(seg.id) !== estimateSegmentHeight(seg)) same = false;
            }
            if (same && prev!.size === count) return prev!;
            const next = new Map<string, number>();
            for (const seg of segments()) {
              if (!layout.isMeasured(seg.id)) next.set(seg.id, estimateSegmentHeight(seg));
            }
            return next;
          });
          /**
           * The markdown a segment will draw, parsed ahead of it. A reply
           * still being written is skipped — it mounts on screen and is new on
           * every token — and a thought only when thoughts open by default.
           */
          const warmSegment = (seg: TurnSegment) => {
            const thoughts = readThinkingOpen();
            const text = (blocks: readonly ContentBlock[] | undefined) => {
              for (const b of blocks ?? []) {
                if (b.type === "text" || (thoughts && b.type === "thinking")) warmMarkdown(b.text);
              }
            };
            if (seg.part === 0) text(seg.turn.user);
            for (let i = seg.msgFrom; i < seg.msgTo; i++) {
              const m = seg.turn.assistant[i];
              if (m && !m.partial) text(m.content);
            }
          };
          let scroller: HTMLDivElement | undefined;
          let host: HTMLDivElement | undefined;
          const owner = createScrollOwner({
            scroller: () => scroller,
            host: () => host,
            layout,
            initial: recallReading(key) ?? { pinned: true },
            remember: (reading) => rememberReading(key, reading),
          });
          const onScroll = scrollCoalescer(owner.onScroll);
          createEffect(() => {
            const g = owner.gesturing();
            // The path actions live above the transcript and ask whether the
            // reader is moving the column; the owner is the only thing that
            // knows.
            setGesturing(g);
            props.onScrollGate?.({
              gesturing: g,
              following: owner.following(),
            });
            // The gesture ended: whatever was waiting for the reader to stop
            // can run now — and whatever was waiting for the reader to reach
            // a path can look again.
            if (!g) {
              for (const fn of waiting) fn();
            }
          });
          // Memoized so the rail's ticks compare a stable id: computing it
          // per read ran the outline lookup once per tick per frame. With the
          // memo, a scroll that never crosses a prompt boundary changes
          // nothing.
          const activeId = createMemo(() => {
            if (owner.following()) return entries().at(-1)?.turnId;
            // The owner's index is a row index now; the outline counts turns.
            const turnIndex = segments()[owner.activeIndex()]?.turnIndex ?? 0;
            return promptAt(entries(), turnIndex)?.turnId;
          });

          props.api?.({
            jumpTo: owner.jumpTo,
            jumpToIndex: (index, align) => {
              const id = props.turns[Math.round(index)]?.turn_id;
              if (id) owner.jumpTo(id, align);
            },
            toLatest: owner.toLatest,
          });

          return (
            <DisclosureContext.Provider value={readDisclosure(key)}>
              <PathActions.Provider value={pathApi}>
              <ContentSashes />
              <div
                ref={(el) => (scroller = el)}
                // overflow-anchor: Chromium's scroll anchoring is a second
                // owner — it moves scrollTop on its own when the content's
                // height changes, and the owner would absorb that as a reader
                // scroll and unpin them. The owner does the compensating now.
                class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [overflow-anchor:none]"
                data-transcript-scroller=""
                onScroll={onScroll}
              >
                <div
                  class={`${showNav() ? "mx-auto w-full px-11 py-4" : "mx-auto w-full px-5 py-4"}${
                    props.turns.length === 0 ? " flex min-h-full flex-col" : ""
                  }`}
                  style={{
                    "max-width": `calc(${contentW()}px + ${showNav() ? "5.5rem" : "2.5rem"})`,
                  }}
                >
                  <Show when={props.ready} fallback={<LoadingTranscript />}>
                    <Show when={props.turns.length > 0} fallback={props.empty}>
                      {/* The wrapper marks where the list starts inside the
                          scroller's content — the owner's `origin`. */}
                      <div ref={(el) => (host = el)}>
                        <Virtual
                          items={segments()}
                          id={(seg) => seg.id}
                          layout={layout}
                          commit={(heights) => {
                            // Absorb against the layout the reader is looking
                            // at *before* it changes — otherwise the write's
                            // clamp reads as a scroll when the owner applies.
                            owner.absorb();
                            layout.commit(heights);
                          }}
                          top={() => {
                            // Following means the tail, including the frames
                            // before the owner has measured the viewport or
                            // written the position — a window built on the
                            // scroller's 0 paints the head on the way there.
                            if (owner.following()) {
                              return Math.max(0, layout.end() - Math.max(0, owner.viewport()));
                            }
                            // origin is the value this scroll pass already measured.
                            return owner.top() - owner.origin();
                          }}
                          viewport={owner.viewport}
                          warm={warmSegment}
                        >
                          {(seg) => (
                            <div data-turn-id={seg().turn.turn_id} data-row-id={seg().id}>
                              {/* Untracked for the reason `Virtual` gives: a turn
                                  built inside an expression that reads the
                                  segment is torn down and built again whenever
                                  the segment changes — every snapshot, for the
                                  turn a reply is streaming into. */}
                              {untrack(() => props.renderTurn(() => seg().turn, () => seg()))}
                            </div>
                          )}
                        </Virtual>
                      </div>
                    </Show>
                  </Show>
                </div>
              </div>

              <Show when={showNav()}>
                <PromptNavigator
                  entries={entries()}
                  activeId={activeId()}
                  onSelect={(turnId) => owner.jumpTo(turnId, "start")}
                />
              </Show>

              <Show
                when={
                  props.ready &&
                  props.latest !== false &&
                  !owner.following() &&
                  props.turns.length > 0
                }
              >
                <Tip label={t("nav.latest")}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon"
                    aria-label={t("nav.latest")}
                    class="surface-popover absolute bottom-4 left-1/2 z-20 -translate-x-1/2"
                    onClick={() => owner.toLatest()}
                  >
                    <Icon name="arrow-down" class="size-4" />
                  </Button>
                </Tip>
              </Show>

              {/* A path that resolved to nothing reachable gets a fading word
                  where the click happened, not at the foot of a column the
                  reader may have scrolled away from. */}
              <Show when={pathErr()}>
                {(e) => (
                  <p
                    class="surface-popover absolute z-30 -translate-x-1/2 rounded-md px-3 py-1.5 text-xs text-destructive"
                    classList={{ "-translate-y-full": !e().centered }}
                    style={{
                      left: e().centered ? "50%" : `${e().x}px`,
                      top: e().centered ? "auto" : `${e().y}px`,
                      bottom: e().centered ? "4rem" : "auto",
                    }}
                  >
                    {e().text}
                  </p>
                )}
              </Show>
              </PathActions.Provider>
            </DisclosureContext.Provider>
          );
        }}
      </Show>
    </div>
  );
}
