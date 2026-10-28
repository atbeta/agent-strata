/**
 * The only code that writes the transcript scroller's scroll position.
 *
 * One owner per transcript: it holds the reading (pinned to the tail, or a row
 * plus how far the viewport's top edge is into it), and one effect writes the
 * position that reading calls for, recomputed absolutely from the current
 * prefix sum. A row above the viewport growing shifts the anchor row's offset,
 * the effect runs in the same task, and the position it writes lands the row
 * exactly where it was — before paint, with nothing accumulated across frames.
 *
 * User scrolls come in through `onScroll` (coalesced by the caller) or are
 * absorbed inside the effect when they arrived between a write and the
 * handler's frame. The reading is remembered on every change, so whatever the
 * reader was looking at survives the transcript unmounting.
 */
import { createEffect, createSignal, onCleanup } from "solid-js";
import { JUMP_GAP, TAIL_TOLERANCE } from "./virtual-tail";
import type { RowLayout } from "./row-layout";

export type Reading =
  | { pinned: true }
  | { pinned: false; turnId: string; offset: number };

/**
 * The reading for a scroll position. Pinned covers the tail, including the
 * overscroll a bounce produces and the frame where the extent is still moving.
 * Otherwise the row containing the viewport's top edge is the memory, and
 * `offset` is how far into that row the edge sits — `scrollTop - (origin +
 * offsets[i])`, negative when the row's top is below the viewport top.
 */
export function readingAt(i: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  origin: number;
  offsets: Float64Array;
  ids: readonly string[];
  tolerance?: number;
}): Reading {
  const tolerance = i.tolerance ?? TAIL_TOLERANCE;
  const count = i.ids.length;
  if (count <= 0 || i.scrollTop + i.clientHeight >= i.scrollHeight - tolerance) {
    return { pinned: true };
  }
  const y = Math.max(0, i.scrollTop - i.origin);
  const o = i.offsets;
  let lo = 0;
  let hi = o.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (o[mid + 1]! <= y) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= count) lo = count - 1;
  const turnId = i.ids[lo];
  if (!turnId) return { pinned: true };
  return { pinned: false, turnId, offset: i.scrollTop - (i.origin + o[lo]!) };
}

/**
 * The position to write. Pinned is the end of the content, not a remembered
 * pixel — the tail moves as measurements land. An anchored row that is absent
 * (a tail preview of three turns while the remembered row is turn 40) has no
 * position to write, so the reading stays pending until the row appears. A
 * scroller that has not been laid out reports a height of 0, and "the tail"
 * against it is the whole extent.
 */
export function targetScrollTop(i: {
  reading: Reading;
  origin: number;
  offsets: Float64Array;
  indexOf: (id: string) => number;
  scrollHeight: number;
  clientHeight: number;
}): number | undefined {
  if (i.clientHeight <= 0) return undefined;
  if (i.reading.pinned) return Math.max(0, i.scrollHeight - i.clientHeight);
  const idx = i.indexOf(i.reading.turnId);
  if (idx < 0) return undefined;
  return i.origin + i.offsets[idx]! + i.reading.offset;
}

/**
 * A browser clamp, not a reader scroll: the content shrank under a written
 * position, so scrollTop fell to the end of what is left. The position is at
 * the very bottom *and* below the last write — a reader's own move up never
 * satisfies both.
 */
export function isClamp(i: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  lastWritten: number | undefined;
}): boolean {
  return (
    i.lastWritten !== undefined &&
    i.lastWritten > i.scrollTop + 1 &&
    i.scrollTop >= i.scrollHeight - i.clientHeight - 1
  );
}

export interface ScrollOwner {
  reading: () => Reading;
  following: () => boolean; // reading().pinned
  /**
   * Scroll offset the list windows on, in scroller coordinates. Set
   * synchronously whenever the owner writes, and from each (coalesced) scroll
   * event.
   */
  top: () => number;
  /** Where the list host starts in the scroller's content (the column's padding). */
  origin: () => number;
  /** Scroller clientHeight, from a ResizeObserver on the scroller. */
  viewport: () => number;
  /** Prompt the outline highlights: last index when following, else the anchored row's. */
  activeIndex: () => number;
  /**
   * Take the reader's position now, against `seen`, before the list's layout
   * changes under it. Called by the commit path before `layout.commit` so a
   * height commit cannot be mistaken for input by the apply pass after it.
   */
  absorb: () => void;
  jumpTo: (turnId: string, align?: "start" | "center") => void;
  toLatest: () => void;
  onScroll: (el: HTMLElement) => void; // wired through scrollCoalescer (scroll-frame.ts)
}

export function createScrollOwner(opts: {
  scroller: () => HTMLElement | undefined;
  /** The list host element (for origin). */
  host: () => HTMLElement | undefined;
  layout: RowLayout;
  initial: Reading;
  remember: (r: Reading) => void;
}): ScrollOwner {
  const [reading, setReading] = createSignal<Reading>(opts.initial);
  const [top, setTop] = createSignal(0);
  const [viewport, setViewport] = createSignal(0);
  /** The position this owner last wrote — or last absorbed — and the layout it was taken against. */
  let lastWritten: number | undefined;
  let seen: { offsets: Float64Array; ids: readonly string[] } | undefined;
  let lastOrigin = 0;
  /** Set by absorb(): the apply pass that follows skips its own absorb — the
   * reading was already taken against the layout that just changed. */
  let fresh = false;

  const origin = (st?: number): number => {
    const el = opts.scroller();
    const host = opts.host();
    if (!el || !host) return lastOrigin;
    lastOrigin =
      host.getBoundingClientRect().top - el.getBoundingClientRect().top +
      (st ?? el.scrollTop);
    return lastOrigin;
  };

  const readPosition = (
    p: { st: number; sh: number; ch: number; orig: number },
    s: { offsets: Float64Array; ids: readonly string[] },
  ) => {
    return readingAt({
      scrollTop: p.st,
      clientHeight: p.ch,
      scrollHeight: p.sh,
      origin: p.orig,
      offsets: s.offsets,
      ids: s.ids,
    });
  };

  const same = (a: Reading, b: Reading): boolean =>
    a.pinned === b.pinned &&
    (a.pinned || (b.pinned === false && a.turnId === b.turnId && a.offset === b.offset));

  /** Record a reading change and hand it to whoever remembers it for this transcript. */
  const place = (r: Reading) => {
    if (same(reading(), r)) return;
    setReading(r);
    opts.remember(r);
  };

  /** The scroller's own height as a signal, so following the tail re-pins when it grows. */
  createEffect(() => {
    const el = opts.scroller();
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    onCleanup(() => ro.disconnect());
  });

  /**
   * The one writer. A plain effect, so it runs after the render effects that
   * update row `top` styles and the host height — writing earlier measures a
   * position the browser has not laid out yet.
   */
  createEffect(() => {
    const offsets = opts.layout.offsets();
    const ids = opts.layout.ids();
    viewport();
    reading();
    const el = opts.scroller();
    if (!el || !el.isConnected) return;

    // One read set per commit. Every layout read after the first hits a
    // clean layout; read them piecemeal and each one forces a layout of
    // its own while the DOM is still dirty.
    const p = {
      st: el.scrollTop,
      sh: el.scrollHeight,
      ch: el.clientHeight,
      orig: 0,
    };
    p.orig = origin(p.st);

    // Absorb a user scroll that landed since the last write and has not yet
    // been coalesced through onScroll — judged against `seen`, the layout the
    // reader was actually looking at, not the new offsets. First pass aside
    // (the DOM position at mount is layout state, not input), a gap of a pixel
    // or more is the reader's own move and becomes the new reading — unless it
    // is a clamp, the browser pulling scrollTop back after the content shrank
    // under it, which is not input either.
    if (fresh) {
      fresh = false;
    } else if (lastWritten !== undefined && Math.abs(p.st - lastWritten) >= 1) {
      if (!isClamp({
        scrollTop: p.st,
        scrollHeight: p.sh,
        clientHeight: p.ch,
        lastWritten,
      })) {
        const s = seen ?? { offsets, ids };
        place(readPosition(p, s));
      }
    }

    const target = targetScrollTop({
      reading: reading(),
      origin: p.orig,
      offsets,
      indexOf: (id) => opts.layout.indexOf(id),
      scrollHeight: p.sh,
      clientHeight: p.ch,
    });
    if (target !== undefined && Math.abs(target - p.st) >= 1) {
      el.scrollTop = target;
      // Read back post-clamp: the browser may not have the extent the layout
      // claims yet, and lastWritten tracks what is actually on screen.
      p.st = el.scrollTop;
    }
    lastWritten = p.st;
    setTop(p.st);
    seen = { offsets, ids };
  });

  onCleanup(() => {
    const el = opts.scroller();
    if (!el?.isConnected) return;
    // A scroll right before a switch would be lost: absorb once more against
    // the layout the reader last saw, and remember what they were on.
    if (lastWritten !== undefined && Math.abs(el.scrollTop - lastWritten) >= 1) {
      const s = seen ?? { offsets: opts.layout.offsets(), ids: opts.layout.ids() };
      const p = { st: el.scrollTop, sh: el.scrollHeight, ch: el.clientHeight, orig: 0 };
      p.orig = origin(p.st);
      opts.remember(readPosition(p, s));
    }
  });

  return {
    reading,
    following: () => reading().pinned,
    top,
    origin,
    viewport,
    activeIndex: () => {
      const r = reading();
      if (r.pinned) return Math.max(0, opts.layout.ids().length - 1);
      return opts.layout.indexOf(r.turnId);
    },
    jumpTo: (turnId, align = "center") => {
      // A jump is the reader leaving the tail — the reading drops the pin, and
      // the apply effect lands it and re-lands it as measurements arrive, so
      // there is no settle loop.
      if (align === "start") {
        place({ pinned: false, turnId, offset: -JUMP_GAP });
        return;
      }
      const i = opts.layout.indexOf(turnId);
      const h = i >= 0 ? opts.layout.heightOf(i) : 0;
      place({ pinned: false, turnId, offset: -Math.max(0, (viewport() - h) / 2) });
    },
    toLatest: () => {
      place({ pinned: true });
    },
    absorb: () => {
      const el = opts.scroller();
      if (!el || !el.isConnected) return;
      const r = reading();
      // The DOM still shows `seen` — the layout the reader was last left at —
      // so a position read now is the true, unclamped one. With nothing
      // written yet, only an anchored reading is worth refreshing; a pinned
      // one is the tail wherever the DOM sits.
      const p = {
        st: el.scrollTop,
        sh: el.scrollHeight,
        ch: el.clientHeight,
        orig: 0,
      };
      p.orig = origin(p.st);
      const moved =
        lastWritten !== undefined
          ? Math.abs(p.st - lastWritten) >= 1
          : !r.pinned && p.ch > 0;
      if (moved) {
        const s = seen ?? { offsets: opts.layout.offsets(), ids: opts.layout.ids() };
        place(readPosition(p, s));
      }
      lastWritten = p.st;
      fresh = true;
    },
    onScroll: (el) => {
      // The owner's own write echoes back as a scroll event; it is not input.
      const st = el.scrollTop;
      if (lastWritten !== undefined && Math.abs(st - lastWritten) < 1) return;
      // Nor is the clamp's event, which arrives a frame after the write it
      // undid.
      const p = { st, sh: el.scrollHeight, ch: el.clientHeight, orig: 0 };
      if (isClamp({
        scrollTop: p.st,
        scrollHeight: p.sh,
        clientHeight: p.ch,
        lastWritten,
      })) return;
      p.orig = origin(p.st);
      const offsets = opts.layout.offsets();
      const ids = opts.layout.ids();
      place(readPosition(p, { offsets, ids }));
      lastWritten = p.st;
      setTop(p.st);
      seen = { offsets, ids };
    },
  };
}
