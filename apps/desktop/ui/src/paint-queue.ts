/**
 * Spread settled-row paint across frames.
 *
 * A transcript row parses its markdown on the main thread. Doing every newly
 * mounted row in the scroll handler is the hitch: the pointer stops updating,
 * then jumps when the thread frees. The queue runs at least one job per frame
 * and then stops once the budget is spent, so a heavy row costs one frame and
 * a run of cached rows catches up together.
 */
export function createPaintQueue(
  requestFrame: (cb: () => void) => void,
  now: () => number,
  budgetMs: number,
) {
  const queue: Array<() => void> = [];
  let scheduled = false;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestFrame(() => {
      scheduled = false;
      const start = now();
      while (queue.length > 0) {
        queue.shift()?.();
        if (now() - start >= budgetMs) break;
      }
      if (queue.length > 0) schedule();
    });
  }

  return {
    enqueue(job: () => void): PaintCancel {
      queue.push(job);
      schedule();
      const cancel = (() => {
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
      }) as PaintCancel;
      // A row that was waiting off screen and has since crossed into view
      // wants this job next, without running it inside the scroll turn.
      cancel.prioritize = () => {
        const index = queue.indexOf(job);
        if (index > 0) {
          queue.splice(index, 1);
          queue.unshift(job);
        }
      };
      return cancel;
    },
  };
}

/**
 * How a row that has not painted yet should get its first paint.
 *
 * `now` parses on this turn. That is a row mounted already on screen, and a
 * reply that is still being written — deferring either one flashes an empty
 * line where the reader is looking.
 *
 * `soon` is a row that was queued while it sat in the overscan and has since
 * scrolled into view. Parsing it here would run inside the scroll turn, which
 * is the hitch. The job stays queued and moves to the front, so the next
 * frame does it before the rows that are still off screen.
 *
 * `later` waits its turn. The queue already spreads those across frames.
 */
export function firstPaint(input: { live: boolean; visible: boolean; queued: boolean }): "now" | "soon" | "later" {
  if (input.live || (input.visible && !input.queued)) return "now";
  if (input.visible) return "soon";
  return "later";
}

/** A cancel handle that can also move its job ahead of the ones still waiting. */
export type PaintCancel = (() => void) & { prioritize: () => void };

const frames =
  typeof requestAnimationFrame === "function"
    ? (cb: () => void) => requestAnimationFrame(cb)
    : (cb: () => void) => queueMicrotask(cb);

/** About one heavy markdown parse, or several cache hits. */
const paintQueue = createPaintQueue(frames, () => performance.now(), 12);

export const enqueuePaint = paintQueue.enqueue;
