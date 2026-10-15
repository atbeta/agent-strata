import { createEffect, createMemo, createSignal, For, onCleanup, onMount, type JSX } from "solid-js";
import { atTail, scrollTopForRow, scrollTopToCentreRow } from "./virtual-tail";

/**
 * Windowed list for rows of unknown height.
 *
 * A long session is not a long document. The biggest one in the store is 1,589
 * turns, which as plain markup comes to ~47,000 nodes and 210,000px of scroll
 * height — and Solid builds all of it before the first frame, so opening that
 * session cost seconds no matter how quickly the service answered (it answers
 * in 60ms; the other 2.1s was node construction). Only the rows near the
 * viewport are worth building. The rest is a number in a prefix sum.
 *
 * Heights are learned rather than guessed. A row that has been on screen keeps
 * its measurement, so the scrollbar settles as the reader works through it; a
 * row that has never been seen falls back to `estimate`. That estimate is the
 * one honest compromise here — it leaves the scrollbar approximate for history
 * nobody has visited yet — and it is why the list opens at the bottom, where
 * the rows on screen are also the first ones the browser gets to measure.
 *
 * Applying a measurement must not yank the page. When a row above the viewport
 * changes height, everything below it moves, so `scrollTop` is corrected by the
 * same delta. Without that, scrolling up through unmeasured history would shift
 * under the pointer on every row the browser finally got around to sizing. A
 * reader following the tail instead gets re-pinned to it, since replacing
 * estimates with real heights moves the end of the list.
 */

/** Sub-pixel height churn is noise; re-rendering a row for 0.2px is not free. */
const EPS = 0.5;

export interface VirtualProps<T> {
  items: readonly T[];
  /** Stable per-row identity. Measurements are keyed by it, so it must survive re-renders. */
  id: (item: T, index: number) => string;
  /** Height for a row that has never been measured. */
  estimate: number;
  /** Space between rows, folded into the prefix sum so the scrollbar includes it. */
  gap: number;
  /** Live scroll offset and viewport height of the scrolling ancestor. */
  scrollTop: number;
  viewport: number;
  /** Extra pixels kept mounted above and below the viewport. */
  overscan?: number;
  /** The scrolling ancestor, for scrollTop correction when measurements land. */
  scroller?: () => HTMLElement | undefined;
  /** Receives the imperative handle once the list is mounted. */
  api?: (a: VirtualApi) => void;
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
  children: (item: () => T, index: number) => JSX.Element;
}

/** What a parent can ask of the list once it is on screen. */
export interface VirtualApi {
  /**
   * Bring a row into view. Centred by default: a reader who jumped here is
   * looking for something, and the point of the jump is to see it in context
   * rather than to land on its top edge with nothing above it.
   *
   * This deliberately gives up the tail. Following is a promise to stay
   * pinned, and a jump is the reader saying they want somewhere else — if the
   * flag survived, the next measurement would pull them straight back.
   */
  scrollToIndex: (index: number, align?: "center" | "start") => void;
  /** Index of the row nearest the top of the viewport. */
  indexAtTop: () => number;
}

export function Virtual<T>(props: VirtualProps<T>) {
  const overscan = () => props.overscan ?? 800;
  const [measured, setMeasured] = createSignal(new Map<string, number>());
  /**
   * Whether the reader is following the tail. Answered against this list's own
   * prefix sum, never against the DOM: `scrollHeight` is a moving target while
   * measurements are still landing, so a comparison against it flips to "not at
   * the bottom" the instant the end of the list moves, and the list then sticks
   * where it happened to be when it lost the flag.
   */
  const [following, setFollowing] = createSignal(true);
  /**
   * Element → the row it was bound to. `For` keeps a node when `rows()` still
   * holds its index, so on a session switch the same element renders a new
   * item while its recorded key still names the old one — the sweep below
   * rebinds it before a measurement can land under the wrong name.
   */
  const observed = new Map<Element, { key: string; i: number }>();
  let host: HTMLDivElement | undefined;
  let scroller: HTMLElement | undefined;
  /**
   * A scroll this list made itself, overriding the parent's mirror until the
   * reader scrolls again. See `rows()`.
   */
  const [pendingTop, setPendingTop] = createSignal<number | undefined>(undefined);

  /**
   * Built before the JSX, not in onMount. Element refs run while the returned
   * markup is being created, so an observer that only existed after mount left
   * the first rows unwatched — and since Solid reuses those same nodes when the
   * window moves back over them, their refs never ran again. Every row already
   * on screen then sat at `estimate` forever: five rows spaced 132px apart
   * whose real heights were 597, 301, 645, 145 and 72, printed on top of one
   * another. Scrolling happened to hide it, because rows mounted later were
   * watched correctly.
   */
  const ro = new ResizeObserver((entries) => {
    const el = props.scroller?.();
    const next = new Map(measured());
    const o = offsets();
    // Read the live offset, not props.scrollTop. The parent mirrors scroll
    // position into a signal through an onScroll handler, and that mirror can
    // be a frame behind when the browser reports sizes — trusting it here
    // writes a stale position back and throws the reader to the wrong place.
    const top = el?.scrollTop ?? props.scrollTop;
    let changed = false;
    let correction = 0;
    let index: Map<string, number> | undefined;
    for (const e of entries) {
      const key = observed.get(e.target)?.key;
      if (key === undefined) continue;
      const h = e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).offsetHeight;
      if (!h) continue;
      const prev = next.get(key);
      // A row never measured still occupies `estimate` in the prefix sum, so
      // its first real height displaces everything below it exactly like a
      // change does — `prev` falls back to the estimate, not to "skip".
      const prevH = prev ?? props.estimate;
      if (Math.abs(prevH - h) < EPS) continue;
      next.set(key, h);
      changed = true;
      // Only rows entirely above the viewport push the content the reader is
      // looking at. Rows below it are already off-screen and cost nothing.
      index ??= rowIndex();
      const i = index.get(key);
      if (i !== undefined && o[i]! + prevH <= top) correction += h - prevH;
    }
    if (!changed) return;
    setMeasured(next);
    // While following, the effect above re-pins using the new extent. The
    // per-row correction is for a reader who has scrolled away, where the
    // content they are reading must not move underneath them.
    if (!following() && correction !== 0 && el) el.scrollTop = top + correction;
  });

  /**
   * Turn id to its row number, so a measurement does not have to search.
   *
   * A plain function, not a memo: it walks every item in the session — 1,589 of
   * them in the largest one held — and a memo made that walk happen on every
   * streaming tick to have it ready for a resize callback that mostly never
   * needs it. It is now built by the resize callback, and only when a row that
   * was already on screen has changed height.
   */
  const rowIndex = (): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < props.items.length; i++) m.set(props.id(props.items[i], i), i);
    return m;
  };

  /** Prefix sums of row height + gap. Index n is the top edge of row n. */
  const offsets = createMemo(() => {
    const n = props.items.length;
    const out = new Float64Array(n + 1);
    const h = measured();
    let acc = 0;
    for (let i = 0; i < n; i++) {
      out[i] = acc;
      acc += (h.get(props.id(props.items[i], i)) ?? props.estimate) + props.gap;
    }
    out[n] = acc;
    return out;
  });

  /** Index of the row containing pixel `y`; `items.length` when y is past the end. */
  const rowAt = (o: Float64Array, y: number): number => {
    let lo = 0;
    let hi = props.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (o[mid + 1] <= y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const rows = createMemo(() => {
    const n = props.items.length;
    if (!n) return [];
    const o = offsets();
    // `top` prefers a programmatic scroll this list just made over the parent's
    // mirror of it. The mirror arrives through `onScroll`, which is a frame
    // behind, and the row a jump went to is not in the window until the window
    // is told about the scroll — which is what leaving this on the parent alone
    // prevented.
    const top = pendingTop() ?? props.scrollTop;
    const first = rowAt(o, Math.max(0, top - overscan()));
    const last = Math.min(n - 1, rowAt(o, top + props.viewport + overscan()));
    const out: number[] = [];
    for (let i = first; i <= last; i++) out.push(i);
    return out;
  });

  const end = () => offsets()[props.items.length];

  /**
   * Where this list's box starts inside the scroller's content. The transcript
   * sits inside a padded container, so row 0 is not at scroll position 0 and
   * measuring beats hard-coding the padding the caller happens to use today.
   */
  const origin = (): number => {
    const el = props.scroller?.();
    if (!el || !host) return 0;
    return host.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  };

  /**
   * A row's real height when it is on screen, else the estimate.
   *
   * A jump always comes from something the reader clicked, so the row they
   * jumped to is mounted and measured. Reading the measurement rather than the
   * estimate is what lets the centring below be right on the first frame.
   */
  const heightOf = (index: number): number => {
    const id = props.id(props.items[index]!, index);
    return measured().get(id) ?? props.estimate;
  };

  const scrollToIndex: VirtualApi["scrollToIndex"] = (index, align = "center") => {
    const el = props.scroller?.();
    if (!el || !props.items.length) return;
    const i = Math.max(0, Math.min(props.items.length - 1, Math.round(index)));
    const top = origin() + offsets()[i];
    setFollowing(false);
    el.scrollTop =
      align === "start"
        ? scrollTopForRow(top)
        : scrollTopToCentreRow(top, heightOf(i), el.clientHeight, end());
    // The window this list renders is computed from the scroll position, which
    // the parent mirrors through its own `onScroll` handler — a frame behind the
    // scroll just written. Saying so here is what mounts the row that was jumped
    // to: without it the reader lands on whatever the window still held, and a
    // tick in the nav claims a jump that never happened on screen.
    setPendingTop(el.scrollTop);
  };

  /**
   * The scroller's own height, as a signal, so following the tail can depend on
   * it.
   *
   * Re-pinning on `end()` covers a new turn and a row finally being measured.
   * It did not cover the scroller changing size — and this transcript's does,
   * the moment the dock beneath it grows to its cap for the pending questions
   * it has just fetched. The list stayed correctly pinned to a bottom that no
   * longer existed: `end()` did not move, so nothing re-ran, and the reader
   * was left 500px above the turn they had just sent, with a button as the
   * only way back to it.
   */
  const [scrollerHeight, setScrollerHeight] = createSignal(0);

  /** Follow the tail: re-pin whenever the content's extent, or the window, changes. */
  createEffect(() => {
    scrollerHeight();
    const total = end();
    const el = props.scroller?.();
    if (!el || !total) return;
    if (following()) el.scrollTop = Math.max(0, total - el.clientHeight);
  });

  const onScroll = () => {
    if (!scroller) return;
    // The reader moved: the parent's mirror is the truth again.
    setPendingTop(undefined);
    const at = atTail(scroller.scrollTop, scroller.clientHeight, end());
    if (at !== following()) setFollowing(at);
  };

  onMount(() => {
    scroller = props.scroller?.();
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    const rov = new ResizeObserver(() => {
      const el = scroller;
      if (el) setScrollerHeight(el.clientHeight);
    });
    if (scroller) {
      rov.observe(scroller);
      setScrollerHeight(scroller.clientHeight);
    }

    props.api?.({
      scrollToIndex,
      indexAtTop: () => rowAt(offsets(), Math.max(0, props.scrollTop)),
    });
    onCleanup(() => rov.disconnect());
  });

  /**
   * Both of these outlive the component unless it says otherwise: an observer
   * holds a strong reference to every row it watches, and a listener on the
   * scroller keeps calling into signals whose owner is already gone. Leaving a
   * session and coming back installed another pair each time.
   */
  onCleanup(() => {
    scroller?.removeEventListener("scroll", onScroll);
    ro.disconnect();
    observed.clear();
  });

  // Rows come and go as the window moves. ResizeObserver holds a strong
  // reference to everything it watches, so a row that left the DOM has to be
  // released — otherwise scrolling a long session leaks every row it passed.
  createEffect(() => {
    rows();
    queueMicrotask(() => {
      // One `setMeasured` for the whole pass. Committing inside the loop gave
      // each row its own invalidation, and every one of those rebuilt the
      // prefix sum over the entire session — a window of twenty rows arriving
      // unmeasured cost twenty full passes, on the scroll path, and that is
      // what made dragging the window stutter.
      let next: Map<string, number> | undefined;
      for (const [el, entry] of [...observed]) {
        if (!el.isConnected) {
          ro.unobserve(el);
          observed.delete(el);
          continue;
        }
        // The node may have been re-used for a different item since its ref
        // ran — `For` keys rows by index value, and a session switch swaps the
        // items behind the same indices. Rebind before reading; measuring the
        // element under its old key would feed the new row a height that
        // belongs to a conversation it is not in — which is exactly how rows
        // landed on top of one another until a scroll remounted them.
        const current = props.items[entry.i];
        const key = current === undefined ? undefined : props.id(current, entry.i);
        if (key === undefined) continue;
        entry.key = key;
        // A mounted row that has no measurement is being positioned from
        // `estimate`, and `estimate` is a guess about a row's height, not a
        // layout: at 100 against a turn that renders at several hundred, an
        // unmeasured row is not a slightly-short placeholder but one printed
        // on top of its neighbours. The observer is best-effort — an entry can
        // be dropped if the element left `observed` before the callback was
        // delivered, and `unobserve` above can remove a node Solid is still
        // holding — and once that happens there may be no further resize to
        // report. So a mounted row without a measurement is read here rather
        // than waited on. Anything read too early, the observer corrects.
        if (measured().has(key)) continue;
        const h = (el as HTMLElement).offsetHeight;
        if (!h) continue;
        next ??= new Map(measured());
        next.set(key, h);
      }
      if (next) setMeasured(next);
    });
  });

  return (
    <div
      ref={(el) => (host = el)}
      class="relative w-full"
      style={{ height: `${offsets()[props.items.length]}px` }}
    >
      <For each={rows()}>
        {(i) => {
          const item = () => props.items[i];
          // Built here, once, rather than inside the markup below. Written as
          // `{props.children(props.items[i], i)}` it compiles to an insert of a
          // thunk that reads `items`, so every row was torn down and rebuilt
          // each time the session's array was replaced — a streaming tick, a
          // refresh, an edit. Held in a local it is a node, not an expression,
          // so it is inserted once and then only ever updated from inside.
          const row = props.children(item, i);
          return (
            <div
              class="absolute left-0 right-0 top-0"
              ref={(el) => {
                observed.set(el, { key: props.id(item(), i), i });
                ro.observe(el);
              }}
              style={{ transform: `translateY(${offsets()[i]}px)` }}
            >
              {row}
            </div>
          );
        }}
      </For>
    </div>
  );
}
