/**
 * One open label at a time.
 *
 * A label describes what is under the pointer, and only one thing is under the
 * pointer. The browser re-runs its hit test after a scroll and fires
 * `mouseenter` for whatever landed under the pointer then, so a scroll through
 * a transcript full of tips leaves a label open for every row the pointer
 * passed over — and every open label runs a frame loop that measures its
 * trigger, so the loops pile up with the distance scrolled.
 *
 * The main thread is what the pointer's shape is drawn from. Once it is busy
 * with those loops it stops keeping up with the reader: the pointer stops
 * changing, and only catches up when the thread frees.
 *
 * So the labels share a slot: the one that opens takes it, and the one that
 * held it is closed.
 */
export interface OpenLabel {
  /**
   * Take the slot, closing whoever holds it.
   *
   * The closer is the label's own way of ending itself, so that a label which
   * is already open does not close and reopen itself in the same breath.
   */
  claim: (close: () => void) => void;
  /** Give the slot up, if this label holds it. */
  release: (close: () => void) => void;
}

export function createOpenLabel(): OpenLabel {
  let open: (() => void) | undefined;
  return {
    claim: (close) => {
      if (open && open !== close) open();
      open = close;
    },
    release: (close) => {
      if (open === close) open = undefined;
    },
  };
}
