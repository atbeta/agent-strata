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
