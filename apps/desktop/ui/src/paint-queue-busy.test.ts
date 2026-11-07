import { describe, expect, test } from "bun:test";
import { createPaintQueue } from "./paint-queue";

describe("warming while the reader is busy", () => {
  const harness = (budgetMs: number, busy?: () => boolean, busyBudgetMs = 4) => {
    let clock = 0;
    const frames: Array<() => void> = [];
    const queue = createPaintQueue(
      (cb) => {
        frames.push(cb);
      },
      () => clock,
      budgetMs,
      busy,
      busyBudgetMs,
    );
    return {
      queue,
      frames,
      advance: (ms: number) => {
        clock += ms;
      },
      /** A job that costs time, so the budget can bite. */
      job: (ran: number[], tag: number, costMs = 6) => () => {
        ran.push(tag);
        clock += costMs;
      },
      flush: () => {
        const run = frames.shift();
        if (!run) throw new Error("no frame was scheduled");
        run();
      },
    };
  };

  test("the reader's frame spends only the small budget", () => {
    // Parsing yields to the reader, but it does not stop. A queue that pauses
    // hands the reader rows that arrive unprepared: the row parses on the
    // frame it appears and its height moves the content under the reader.
    const h = harness(12, () => true, 4);
    const ran: number[] = [];
    h.queue.enqueue(h.job(ran, 1));
    h.queue.enqueue(h.job(ran, 2));
    h.queue.enqueue(h.job(ran, 3));
    h.flush();
    // The first job costs 6ms, which is already past the 4ms busy budget.
    expect(ran).toEqual([1]);
    // The rest wait for the next frame — the queue is still in flight.
    expect(h.frames.length).toBe(1);
  });

  test("an idle frame spends the whole budget", () => {
    const h = harness(12);
    const ran: number[] = [];
    h.queue.enqueue(h.job(ran, 1));
    h.queue.enqueue(h.job(ran, 2));
    h.queue.enqueue(h.job(ran, 3));
    h.flush();
    // 6ms, then 12ms — the budget is spent and the third job waits.
    expect(ran).toEqual([1, 2]);
    expect(h.frames.length).toBe(1);
  });

  test("without a busy predicate the queue behaves as before", () => {
    const h = harness(12);
    const ran: number[] = [];
    h.queue.enqueue(h.job(ran, 1));
    h.flush();
    expect(ran).toEqual([1]);
  });

  test("a busy reader never leaves the queue stalled", () => {
    // The freeze: the queue deferred while the reader was busy and the backlog
    // landed in one burst when the pause ended — a window that stops answering
    // input. The queue now keeps going on the smaller budget, so the backlog
    // is worked off a row at a time instead of all at once.
    let busy = true;
    const h = harness(12, () => busy, 4);
    const ran: number[] = [];
    for (let i = 0; i < 200; i++) h.queue.enqueue(h.job(ran, i));
    // However many jobs arrive, at most one frame is pending.
    expect(h.frames.length).toBeLessThanOrEqual(1);
    let guard = 0;
    while (ran.length < 200 && guard++ < 500) {
      h.flush();
      if (h.frames.length === 0) break;
    }
    expect(ran.length).toBe(200);
    // Every row was prepared, none of them in one burst.
    expect(h.frames.length).toBeLessThanOrEqual(1);
    busy = false;
  });

  test("a cancelled job leaves the queue alone", () => {
    const h = harness(12);
    const ran: number[] = [];
    const cancel = h.queue.enqueue(h.job(ran, 1));
    h.queue.enqueue(h.job(ran, 2));
    cancel();
    h.flush();
    expect(ran).toEqual([2]);
  });
});
