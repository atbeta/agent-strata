import { createEffect, createMemo, createSignal, For, onCleanup, untrack, type JSX } from "solid-js";
import { enqueueWarm } from "./paint-queue";
import { stableKeys } from "./keyed";
import { aheadOrder, mountedRange, type Range } from "./virtual-window";
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
   * Prepare a row before it mounts — parse its markdown into the cache — so a
   * row that comes into the window off screen mounts complete in one go. A row
   * on screen mounts at once, warmed or not. Without it every row mounts at once.
   */
  warm?: (item: T) => void;
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
      if (id === undefined) continue;
      const h = e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).offsetHeight;
      if (!h) continue;
      next ??= new Map();
      next.set(id, h);
    }
    // One commit for the whole pass: the layout recomputes its prefix sum once,
    // and the scroll owner re-anchors in the same task, before paint.
    if (next) props.commit(next);
  });

  const sameRange = (a: Range, b: Range) => a.first === b.first && a.last === b.last;
  /**
   * What is on screen, and what is kept ahead of it. Compared by value, so the
   * scroll position only wakes the window when a row crosses either edge.
   *
   * Pixel windows only. A row cap unmounted rows the reader was about to
   * reach, and mounting them again parsed markdown on the scroll frame. The
   * estimate is what keeps the count near the rows actually on screen. A
   * position remembered from another session can sit past this one's end;
   * mountedRange clamps that onto the last row, so the pane still has rows to
   * draw.
   */
  const ranges = createMemo<{ visible: Range; ahead: Range } | undefined>(
    () => {
      const n = props.items.length;
      if (!n) return undefined;
      const at = (pad: number) =>
        mountedRange({
          count: n,
          top: props.top(),
          viewport: props.viewport(),
          overscan: pad,
          rowAt: (y) => props.layout.rowAt(y),
        });
      return { visible: at(0), ahead: at(overscan()) };
    },
    undefined,
    {
      equals: (a, b) =>
        a === b || (!!a && !!b && sameRange(a.visible, b.visible) && sameRange(a.ahead, b.ahead)),
    },
  );
  /**
   * Rows whose markdown is already parsed: warmed ahead of the view, or
   * mounted on screen. Either way the row can stay mounted while it is in the
   * window, so it is not torn down the moment it scrolls off screen.
   */
  const warmed = new Set<string>();
  const [warmth, setWarmth] = createSignal(0);
  const queued = new Map<string, () => void>();

  const windowIds = createMemo<readonly string[]>((prev) => {
    warmth();
    const r = ranges();
    if (!r) return stableKeys(prev, []);
    const ids: string[] = [];
    for (let i = r.ahead.first; i <= r.ahead.last; i++) {
      const id = props.id(props.items[i]!);
      if (i >= r.visible.first && i <= r.visible.last) warmed.add(id);
      if (!props.warm || warmed.has(id)) ids.push(id);
    }
    // While the same rows are in the window the same list is reused, so a
    // streaming tick or a scroll inside the window leaves the rows alone.
    return stableKeys(prev, ids);
  });

  // Rows ahead of the view are warmed nearest first, a budget per frame, and
  // mount as each one finishes. A row that left the window before its turn is
  // dropped from the queue, so a fling does not leave a trail of parses.
  //
  // Warming does not stop while the reader is moving: a row that is not ready
  // when the reader reaches it parses on the frame it appears, and its height
  // moves the content under the reader. The queue is what keeps the
  // preparation ahead of the view, and it throttles itself instead.
  createEffect(() => {
    const warm = props.warm;
    const r = ranges();
    const want = new Set<string>();
    if (warm && r) {
      for (const i of aheadOrder(r.visible, r.ahead)) {
        const id = props.id(props.items[i]!);
        if (warmed.has(id)) continue;
        want.add(id);
        if (queued.has(id)) continue;
        queued.set(
          id,
          enqueueWarm(() => {
            queued.delete(id);
            const item = props.items[props.layout.indexOf(id)];
            if (item !== undefined) warm(item);
            warmed.add(id);
            setWarmth((n) => n + 1);
          }),
        );
      }
    }
    for (const [id, cancel] of queued) {
      if (want.has(id)) continue;
      cancel();
      queued.delete(id);
    }
  });

  /**
   * Both of these outlive the component unless it says otherwise: an observer
   * holds a strong reference to every row it watches. Leaving a session and
   * coming back installed another pair each time.
   */
  onCleanup(() => {
    ro.disconnect();
    observed.clear();
    for (const cancel of queued.values()) cancel();
    queued.clear();
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
        if (props.layout.isMeasured(id)) continue;
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
          return (
            <div
              class="absolute left-0 right-0"
              ref={(el) => {
                observed.set(el, id);
                ro.observe(el);
              }}
              // `top`, not `transform`: a transformed ancestor becomes a
              // containing block that `position: sticky` cannot see past,
              // which would keep an open thought's header from pinning.
              style={{ top: `${props.layout.offsets()[index()]}px` }}
            >
              {/* Once, outside the insert that tracks `items`. Written in
                  the markup as `{props.children(props.items[i])}` it became
                  a thunk that reads `items`, and every streaming tick tore
                  the row down and parsed its markdown again. `untrack` keeps
                  that call from joining the style update. */}
              {untrack(() => props.children(item))}
            </div>
          );
        }}
      </For>
    </div>
  );
}
