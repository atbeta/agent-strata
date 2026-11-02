import { createEffect, createMemo, For, onCleanup, untrack, type JSX } from "solid-js";
import { createPaintHold, rowPaintHold, rowPaintMode } from "./paint-mode";
import { stableKeys } from "./keyed";
import { mountedRange } from "./virtual-window";
import type { RowLayout } from "./row-layout";

/**
 * Windowed list for rows of unknown height — a renderer only.
 *
 * A long session is not a long document. The biggest one in the store is 1,589
 * turns, which as plain markup comes to ~47,000 nodes and 210,000px of scroll
 * height — and Solid builds all of it before the first frame, so opening that
 * session cost seconds no matter how quickly the service answered (it answers
 * in 60ms; the other 2.1s was node construction). Only the rows near the
 * viewport are worth building. The rest is a number in the layout's prefix sum.
 *
 * Heights are learned rather than guessed. A row that has been on screen keeps
 * its measurement through `layout.commit`, so the scrollbar settles as the
 * reader works through it; a row that has never been seen falls back to the
 * estimate. The position itself belongs to the scroll owner — this list only
 * mounts whatever `top()` + `viewport()` say is on screen and reports the
 * heights it finds.
 */
export function Virtual<T>(props: {
  items: readonly T[];
  /**
   * Stable per-row identity. Rows are mounted and measured by it, so it must
   * survive re-renders. `layout` is built over these same ids.
   */
  id: (item: T) => string;
  /** Row heights and offsets, shared with the scroll owner. */
  layout: RowLayout;
  /**
   * The one measurement publication path — owned by the caller, which absorbs
   * the reader's position against the outgoing layout before committing, so a
   * height change can never be mistaken for a scroll.
   */
  commit: (heights: ReadonlyMap<string, number>) => void;
  /** Scroll offset the window is built on, list-relative. */
  top: () => number;
  /** Height of the scrolling ancestor. */
  viewport: () => number;
  /** Extra pixels kept mounted above and below the viewport. */
  overscan?: number;
  /**
   * Called once per row, when the row is created, and never again.
   *
   * `item` is an accessor rather than the value because the two have to be
   * separated. A session streams in, so `items` is a fresh array on nearly every
   * tick while almost every row in it is byte-identical to last tick. Handing
   * the row the array's current slot means building its markup inside an
   * expression that reads `items`, and a row built in a tracked expression is
   * rebuilt whenever that expression re-runs — which was every tick, for every
   * visible row. Teardown is not cheap: the markdown under each row re-parses,
   * and any tip anchored to a tool call loses its anchor mid-hover and hides.
   * Reading through the accessor instead lets the row's own markup stay put and
   * lets whatever inside it re-read `item()` on its own terms, so a row updates
   * only when its own contents actually change.
   */
  children: (item: () => T) => JSX.Element;
}) {
  const overscan = () => props.overscan ?? 800;
  /**
   * Element → the id of the row it renders. Rows are keyed by id, so an
   * element renders one row for its whole life and its id never goes stale.
   */
  const observed = new Map<Element, string>();
  /**
   * Rows with deferred paints pending, by id. A deferred row paints
   * half-empty and fills in later, so a measurement taken while it is held is
   * the empty box's height — committing it erases the real height learned the
   * last time the row was on screen, the content shrinks by a column, and the
   * clamp reads as a scroll. Held rows are skipped by the observer and the
   * sweep alike; when the last hold releases, the row is queued for exactly
   * one measurement, flushed in a single commit per microtask.
   */
  const rowHolds = new Map<string, { hold: () => () => void; pending: () => number }>();
  const held = (id: string) => (rowHolds.get(id)?.pending() ?? 0) > 0;
  const pendingEls = new Set<Element>();
  let flushQueued = false;
  const queueMeasure = (el: Element) => {
    pendingEls.add(el);
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      let next: Map<string, number> | undefined;
      for (const el of pendingEls) {
        const id = observed.get(el);
        if (id === undefined || !el.isConnected) continue;
        const h = (el as HTMLElement).offsetHeight;
        if (!h) continue;
        next ??= new Map();
        next.set(id, h);
      }
      pendingEls.clear();
      if (next) props.commit(next);
    });
  };
  /**
   * Built before the JSX, not in onMount. Element refs run while the returned
   * markup is being created, so an observer that only existed after mount left
   * the first rows unwatched — and since Solid reuses those same nodes when the
   * window moves back over them, their refs never ran again. Every row already
   * on screen then sat at the estimate forever: five rows spaced 132px apart
   * whose real heights were 597, 301, 645, 145 and 72, printed on top of one
   * another. Scrolling happened to hide it, because rows mounted later were
   * watched correctly.
   */
  const ro = new ResizeObserver((entries) => {
    let next: Map<string, number> | undefined;
    for (const e of entries) {
      const id = observed.get(e.target);
      if (id === undefined || held(id)) continue;
      const h = e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).offsetHeight;
      if (!h) continue;
      next ??= new Map();
      next.set(id, h);
    }
    // One commit for the whole pass: the layout recomputes its prefix sum once,
    // and the scroll owner re-anchors in the same task, before paint.
    if (next) props.commit(next);
  });

  const windowIds = createMemo<readonly string[]>((prev) => {
    const n = props.items.length;
    if (!n) return stableKeys(prev, []);
    // Pixel window only. A row cap unmounted rows the reader was about to
    // reach, and mounting them again parsed markdown on the scroll frame.
    // The estimate is what keeps this count near the rows actually on screen.
    const { first, last } = mountedRange({
      count: n,
      top: props.top(),
      viewport: props.viewport(),
      overscan: overscan(),
      rowAt: (y) => props.layout.rowAt(y),
    });
    // A position remembered from another session can sit past this one's end.
    // mountedRange clamps that onto the last row, so the pane still has rows
    // to draw. While the same rows are in the window the same list is reused,
    // so a streaming tick or a scroll inside the window leaves the rows alone.
    const ids = props.items.slice(first, last + 1).map((item) => props.id(item));
    return stableKeys(prev, ids);
  });

  /**
   * Both of these outlive the component unless it says otherwise: an observer
   * holds a strong reference to every row it watches. Leaving a session and
   * coming back installed another pair each time.
   */
  onCleanup(() => {
    ro.disconnect();
    observed.clear();
  });

  // Rows come and go as the window moves. ResizeObserver holds a strong
  // reference to everything it watches, so a row that left the DOM has to be
  // released — otherwise scrolling a long session leaks every row it passed.
  createEffect(() => {
    windowIds();
    queueMicrotask(() => {
      // One commit for the whole pass. Committing inside the loop gave each
      // row its own invalidation, and every one rebuilt the prefix sum and
      // re-ran the owner's apply effect — N forced layouts on the scroll path.
      let next: Map<string, number> | undefined;
      for (const [el, id] of [...observed]) {
        if (!el.isConnected) {
          ro.unobserve(el);
          observed.delete(el);
          continue;
        }
        // A mounted row that has no measurement is being positioned from the
        // estimate, and the estimate is a guess about a row's height, not a
        // layout: a guess well under a turn that renders at several hundred
        // prints the row on top of its neighbours. The observer is best-effort
        // — an entry can be dropped if the element left `observed` before the
        // callback was delivered, and `unobserve` above can remove a node Solid
        // is still holding — and once that happens there may be no further
        // resize to report. So a mounted row without a measurement is read here
        // rather than waited on. Anything read too early, the observer corrects.
        if (held(id) || props.layout.isMeasured(id)) continue;
        const h = (el as HTMLElement).offsetHeight;
        if (!h) continue;
        next ??= new Map();
        next.set(id, h);
      }
      if (next) props.commit(next);
    });
  });

  return (
    <div
      class="relative w-full"
      style={{ height: `${props.layout.offsets()[props.items.length]}px` }}
    >
      <For each={windowIds()}>
        {(id) => {
          const index = createMemo(() => props.layout.indexOf(id));
          // `For` drops a row in the same update that removed its id, and
          // whatever inside reads the item before then gets the last one it had.
          const item = createMemo<T>((prev) => props.items[index()] ?? prev!);
          // A memo, not the scroll position itself. Markdown subscribes to this,
          // and a subscription to `top` would re-run the paint effect on every
          // pixel. The boolean flips only when the row crosses the fold.
          const inView = createMemo(() => {
            const viewport = props.viewport();
            if (viewport <= 0) return true;
            const top = props.top();
            const y = props.layout.offsets()[index()] ?? 0;
            return y + props.layout.heightOf(index()) > top && y < top + viewport;
          });
          const mode = () => (inView() ? "now" : "idle");
          let rowEl: HTMLDivElement | undefined;
          const paintHold = createPaintHold(() => {
            if (rowEl) queueMeasure(rowEl);
          });
          rowHolds.set(id, paintHold);
          onCleanup(() => {
            if (rowHolds.get(id) === paintHold) rowHolds.delete(id);
          });
          return (
            <rowPaintHold.Provider value={paintHold}>
            <rowPaintMode.Provider value={mode}>
              <div
                class="absolute left-0 right-0"
                ref={(el) => {
                  rowEl = el;
                  observed.set(el, id);
                  ro.observe(el);
                }}
                // `top`, not `transform`: a transformed ancestor becomes a
                // containing block that `position: sticky` cannot see past,
                // which would keep an open thought's header from pinning.
                style={{ top: `${props.layout.offsets()[index()]}px` }}
              >
                {/* Once, outside the insert that tracks `items`. Written in
                    the markup as `{props.children(props.items[i])}` it
                    became a thunk that reads `items`, and every streaming
                    tick tore the row down and parsed its markdown again.
                    `untrack` keeps that call from joining the style update,
                    and it still runs under the provider so the row can see
                    whether it is on screen. */}
                {untrack(() => props.children(item))}
              </div>
            </rowPaintMode.Provider>
            </rowPaintHold.Provider>
          );
        }}
      </For>
    </div>
  );
}
