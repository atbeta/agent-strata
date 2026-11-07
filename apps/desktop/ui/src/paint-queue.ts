/**
 * Spread row warming across frames.
 *
 * A transcript row parses its markdown on the main thread. Doing every row the
 * window is about to mount in the scroll handler is the hitch: the pointer
 * stops updating, then jumps when the thread frees. The queue runs at least
 * one job per frame and then stops once the budget is spent, so a heavy row
 * costs one frame and a run of cached rows catches up together.
 */
import { parsingShouldWait } from "./busy-now";

export function createPaintQueue(
  requestFrame: (cb: () => void) => void,
  now: () => number,
  budgetMs: number,
  /**
   * When true, no job runs this frame.
   *
   * The queue exists to spread parsing across frames, but a reader who is
   * typing or scrolling is already spending the frame. Markdown that is not
   * needed until the next scroll can wait for them to stop: the pointer's
   * shape and the keystroke's echo come first.
   */
  quiet?: () => boolean,
) {
  const queue: Array<() => void> = [];
  let scheduled = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  function schedule() {
    // One pending wake-up, ever. This used to check `scheduled` only, so every
    // `enqueue` during a pause queued another frame, and each frame queued
    // another timer in the quiet branch — overwriting the timer variable while
    // the old timer stayed alive. A long scroll grew that set without bound:
    // hundreds of timers each waking a frame that scheduled another, and the
    // main thread never got back to input. Freezing the window, not a stall.
    if (scheduled || retry !== undefined) return;
    scheduled = true;
    requestFrame(() => {
      scheduled = false;
      if (queue.length > 0 && quiet?.()) {
        // Sleeping beats re-arming every frame: a reader can hold a key for a
        // long time, and each wake-up is a style recalc waiting to happen.
        retry = setTimeout(() => {
          retry = undefined;
          schedule();
        }, 120);
        return;
      }
      const start = now();
      while (queue.length > 0) {
        queue.shift()?.();
        if (now() - start >= budgetMs) break;
      }
      if (queue.length > 0) schedule();
    });
  }

  return {
    /** Queue a job; the returned function takes it back off if it has not run. */
    enqueue(job: () => void): () => void {
      queue.push(job);
      schedule();
      return () => {
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
        if (queue.length === 0 && retry !== undefined) {
          clearTimeout(retry);
          retry = undefined;
        }
      };
    },
  };
}

const frames =
  typeof requestAnimationFrame === "function"
    ? (cb: () => void) => requestAnimationFrame(cb)
    : (cb: () => void) => queueMicrotask(cb);

/** About one heavy markdown parse, or several cache hits. */
const paintQueue = createPaintQueue(
  frames,
  () => performance.now(),
  12,
  // The reader's own work — a gesture, a keystroke — outranks a row that is
  // only being prepared for later.
  parsingShouldWait,
);

export const enqueueWarm = paintQueue.enqueue;
