import { createEffect, createMemo, createSignal, For, onMount, type JSX } from "solid-js";

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
  children: (item: T, index: number) => JSX.Element;
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
  const observed = new Map<Element, string>();
  let ro: ResizeObserver | undefined;
  let host: HTMLDivElement | undefined;

  /** Turn id to its row number, so a measurement does not have to search. */
  const rowIndex = createMemo(() => {
    const m = new Map<string, number>();
    for (let i = 0; i < props.items.length; i++) m.set(props.id(props.items[i], i), i);
    return m;
  });

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
    const first = rowAt(o, Math.max(0, props.scrollTop - overscan()));
    const last = Math.min(n - 1, rowAt(o, props.scrollTop + props.viewport + overscan()));
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

  const scrollToIndex: VirtualApi["scrollToIndex"] = (index, align = "center") => {
    const el = props.scroller?.();
    if (!el || !props.items.length) return;
    const i = Math.max(0, Math.min(props.items.length - 1, Math.round(index)));
    const top = origin() + offsets()[i];
    setFollowing(false);
    el.scrollTop = Math.max(
      0,
      align === "start" ? top : top - Math.max(0, (el.clientHeight - props.estimate) / 2),
    );
  };

  /** Follow the tail: re-pin whenever the content's extent changes under us. */
  createEffect(() => {
    const total = end();
    const el = props.scroller?.();
    if (!el || !total) return;
    if (following()) el.scrollTop = Math.max(0, total - el.clientHeight);
  });

  onMount(() => {
    const el = props.scroller?.();
    el?.addEventListener(
      "scroll",
      () => {
        if (!el) return;
        const at = Math.abs(el.scrollTop + el.clientHeight - end()) < 96;
        if (at !== following()) setFollowing(at);
      },
      { passive: true },
    );

    props.api?.({
      scrollToIndex,
      indexAtTop: () => rowAt(offsets(), Math.max(0, props.scrollTop)),
    });

    ro = new ResizeObserver((entries) => {
      const next = new Map(measured());
      const o = offsets();
      const index = rowIndex();
      // Read the live offset, not props.scrollTop. The parent mirrors scroll
      // position into a signal through an onScroll handler, and that mirror
      // can be a frame behind when the browser reports sizes — trusting it here
      // writes a stale position back and throws the reader to the wrong place.
      const top = el?.scrollTop ?? props.scrollTop;
      let changed = false;
      let correction = 0;
      for (const e of entries) {
        const key = observed.get(e.target);
        if (key === undefined) continue;
        const h = e.borderBoxSize?.[0]?.blockSize ?? (e.target as HTMLElement).offsetHeight;
        if (!h) continue;
        const prev = next.get(key);
        if (prev !== undefined && Math.abs(prev - h) < EPS) continue;
        next.set(key, h);
        changed = true;
        const i = index.get(key);
        // Only rows entirely above the viewport push the content the reader is
        // looking at. Rows below it are already off-screen and cost nothing.
        if (prev !== undefined && i !== undefined && o[i] + prev <= top) correction += h - prev;
      }
      if (!changed) return;
      setMeasured(next);
      // While following, the effect above re-pins using the new extent. The
      // per-row correction is for a reader who has scrolled away, where the
      // content they are reading must not move underneath them.
      if (!following() && correction !== 0 && el) el.scrollTop = top + correction;
    });
  });

  // Rows come and go as the window moves. ResizeObserver holds a strong
  // reference to everything it watches, so a row that left the DOM has to be
  // released — otherwise scrolling a long session leaks every row it passed.
  createEffect(() => {
    rows();
    queueMicrotask(() => {
      if (!ro) return;
      for (const el of [...observed.keys()]) {
        if (!el.isConnected) {
          ro.unobserve(el);
          observed.delete(el);
        }
      }
    });
  });

  return (
    <div
      ref={(el) => (host = el)}
      class="relative w-full"
      style={{ height: `${offsets()[props.items.length]}px` }}
    >
      <For each={rows()}>
        {(i) => (
          <div
            class="absolute left-0 right-0 top-0"
            ref={(el) => {
              observed.set(el, props.id(props.items[i], i));
              ro?.observe(el);
            }}
            style={{ transform: `translateY(${offsets()[i]}px)` }}
          >
            {props.children(props.items[i], i)}
          </div>
        )}
      </For>
    </div>
  );
}
