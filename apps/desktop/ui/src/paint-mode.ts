import { createContext, useContext } from "solid-js";

/** `now` paints in this frame. `idle` waits for {@link enqueuePaint}. */
export type PaintWhen = "now" | "idle";

/**
 * Whether the row currently on screen should paint before the frame ends.
 *
 * The default is `now`, so markdown outside the transcript list is unchanged.
 * The list overrides it per row. The value is an accessor on purpose: a plain
 * string would not notify a row when it scrolls into view.
 */
const paintNow = (): PaintWhen => "now";

export const rowPaintMode = createContext(paintNow);

export function useRowPaintMode(): () => PaintWhen {
  return useContext(rowPaintMode);
}

/**
 * A row that still has deferred paints queued holds its measurement. Painting
 * changes its height, so committing its half-empty box would rebuild the
 * layout with a lie. The list provides the counter per row; outside the list
 * the hold is a no-op.
 */
const noHold = { hold: () => () => {} };

export const rowPaintHold = createContext(noHold);

export function useRowPaintHold(): { hold: () => () => void } {
  return useContext(rowPaintHold);
}

/**
 * The per-row counter. Each hold() returns a token that releases once; when
 * the count reaches zero the row is painted and `settled` fires — the list
 * queues it for one measurement. A token released twice is ignored.
 */
export function createPaintHold(settled: () => void): {
  hold: () => () => void;
  pending: () => number;
} {
  let pending = 0;
  return {
    pending: () => pending,
    hold: () => {
      pending++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--pending === 0) settled();
      };
    },
  };
}
