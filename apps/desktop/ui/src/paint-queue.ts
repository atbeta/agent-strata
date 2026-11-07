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
   * Whether the reader is busy — a keystroke.
   *
   * A gesture is not a reason to hold the queue back: the rows ahead of the
   * view have to be ready before the reader reaches them.
   */
  busy?: () => boolean,
  /**
   * The budget while the reader is busy.
   *
   * Parsing yields to the reader: the keystroke's echo comes first. It does
   * not *stop*, though — and that is the whole difference.
   *
   * The rows ahead of the view have to be ready before the reader reaches
   * them. A queue that pauses hands the reader rows that arrive unprepared:
   * the row parses on the frame it appears, in the middle of the gesture,
   * and its height moves the content under the reader — a jump nobody asked
   * for. Worse, the backlog lands in one burst when the pause ends, which is
   * the window that stops answering input.
   *
   * So the queue keeps going on a smaller budget: the preparation stays ahead
   * of the reader, and the frame stays mostly the reader's.
   */
  busyBudgetMs = 4,
) {
  const queue: Array<() => void> = [];
  let scheduled = false;

  function schedule() {
    // One pending wake-up, ever. This used to check `scheduled` only, so every
    // `enqueue` during a pause queued another frame, and each frame queued
    // another timer in the quiet branch — overwriting the timer variable while
    // the old timer stayed alive. A long scroll grew that set without bound:
    // hundreds of timers each waking a frame that scheduled another, and the
    // main thread never got back to input. Freezing the window, not a stall.
    if (scheduled) return;
    scheduled = true;
    requestFrame(() => {
      scheduled = false;
      const start = now();
      const budget = busy?.() ? busyBudgetMs : budgetMs;
      while (queue.length > 0) {
        queue.shift()?.();
        if (now() - start >= budget) break;
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
  // The reader's own work — a keystroke — outranks a row that is only being
  // prepared for later. It does not stop the queue: a row that arrives
  // unprepared parses on the frame it appears and moves the content under the
  // reader.
  parsingShouldWait,
);

export const enqueueWarm = paintQueue.enqueue;
