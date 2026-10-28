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
    enqueue(job: () => void) {
      queue.push(job);
      schedule();
      return () => {
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
      };
    },
  };
}

const frames =
  typeof requestAnimationFrame === "function"
    ? (cb: () => void) => requestAnimationFrame(cb)
    : (cb: () => void) => queueMicrotask(cb);

/** About one heavy markdown parse, or several cache hits. */
const paintQueue = createPaintQueue(frames, () => performance.now(), 12);

export const enqueuePaint = paintQueue.enqueue;
