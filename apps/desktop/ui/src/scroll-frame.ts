/**
 * A scroll handler that runs at most once per frame.
 *
 * The transcript's handler reads layout (`scrollHeight`, `clientHeight`,
 * `indexAtTop`) and writes four signals. A trackpad produces scroll events far
 * faster than the display refreshes, so without coalescing every one of them
 * did that work — and each `setViewport`/`setActiveTurn` could recompute the
 * mounted window and repaint the outline. That is the "a whole pile of events
 * still firing after I stopped" a reader sees: the gesture ends, the queue of
 * already-scheduled work does not.
 *
 * Last position wins, which is right because the work is a pure function of
 * where the scroller ended up. A frame that has not run yet is cancelled on
 * cleanup, so a pane that unmounts cannot write signals belonging to a session
 * the reader has left.
 */
import { onCleanup } from "solid-js";

export type ScrollWork = (el: HTMLElement) => void;

export function scrollCoalescer(work: ScrollWork): (e: Event & { currentTarget: HTMLElement }) => void {
  let frame = 0;
  let pending: HTMLElement | undefined;

  const flush = () => {
    frame = 0;
    const el = pending;
    pending = undefined;
    if (el) work(el);
  };

  onCleanup(() => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    pending = undefined;
  });

  return (e) => {
    pending = e.currentTarget;
    if (frame) return;
    frame = requestAnimationFrame(flush);
  };
}
