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
import { createMemo, Show, type JSX } from "solid-js";
import type { Turn } from "./api";
import { Virtual } from "./virtual";
import { createRowLayout } from "./row-layout";
import { createScrollOwner } from "./scroll-owner";
import {
  ROW_ESTIMATE,
  ROW_GAP,
  layoutKey,
  readRowHeights,
  recallReading,
  rememberReading,
  writeRowHeight,
} from "./transcript-layout";
import { scrollCoalescer } from "./scroll-frame";
import { ContentSashes, LoadingTranscript } from "./content-sashes";
import { PromptNavigator } from "./prompt-navigator";
import { promptAt, promptEntries } from "./prompt-outline";
import { contentW } from "./session-chrome";
import { Tip } from "./tip";
import { Button } from "@/components/ui/button";
import { Icon } from "./icons";
import { t } from "./i18n";

export interface TranscriptApi {
  jumpTo: (turnId: string, align?: "start" | "center") => void;
  jumpToIndex: (index: number, align?: "start" | "center") => void;
  toLatest: () => void;
}

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
  /** One turn; the <div data-turn-id> wrapper is added here. */
  renderTurn: (turn: () => Turn, index: number) => JSX.Element;
  /** Receives the imperative handle once, and again on each remount. */
  api?: (a: TranscriptApi) => void;
}): JSX.Element {
  const entries = createMemo(() => promptEntries(props.turns));
  const showNav = () => props.nav && entries().length >= 2;

  return (
    <div class={`relative flex flex-1 flex-col ${props.class ?? ""}`}>
      <Show when={layoutKey(props.paneId, props.sessionId)} keyed>
        {(key) => {
          const ids = createMemo(() => props.turns.map((turn) => turn.turn_id));
          const layout = createRowLayout({
            ids,
            estimate: ROW_ESTIMATE,
            gap: ROW_GAP,
            seed: readRowHeights(key),
            onHeight: (id, height) => writeRowHeight(key, id, height),
          });
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
          // Memoized so the rail's ticks compare a stable id: computing it
          // per read ran the outline lookup once per tick per frame. With the
          // memo, a scroll that never crosses a prompt boundary changes
          // nothing.
          const activeId = createMemo(
            () =>
              (owner.following() ? entries().at(-1) : promptAt(entries(), owner.activeIndex()))
                ?.turnId,
          );

          props.api?.({
            jumpTo: owner.jumpTo,
            jumpToIndex: (index, align) => {
              const id = props.turns[Math.round(index)]?.turn_id;
              if (id) owner.jumpTo(id, align);
            },
            toLatest: owner.toLatest,
          });

          return (
            <>
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
                          items={props.turns}
                          id={(turn) => turn.turn_id}
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
                            return owner.top() - owner.origin();
                          }}
                          viewport={owner.viewport}
                        >
                          {(turn, i) => (
                            <div data-turn-id={turn().turn_id}>
                              {props.renderTurn(turn, i)}
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
            </>
          );
        }}
      </Show>
    </div>
  );
}
