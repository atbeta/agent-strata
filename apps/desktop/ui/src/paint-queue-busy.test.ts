import { describe, expect, test } from "bun:test";
import { createPaintQueue } from "./paint-queue";

describe("warming while the reader is busy", () => {
  const harness = (budgetMs: number, quiet?: () => boolean) => {
    let clock = 0;
    const frames: Array<() => void> = [];
    const timers: Array<{ at: number; run: () => void }> = [];
    const queue = createPaintQueue(
      (cb) => {
        frames.push(cb);
      },
      () => clock,
      budgetMs,
      quiet,
    );
    return {
      queue,
      frames,
      timers,
      advance: (ms: number) => {
        clock += ms;
      },
      flush: () => {
        const run = frames.shift();
        if (!run) throw new Error("no frame was scheduled");
        run();
      },
    };
  };

  test("no job runs on a frame the reader owns", () => {
    let busy = true;
    const { queue, frames } = harness(12, () => busy);
    const ran: number[] = [];
    queue.enqueue(() => ran.push(1));
    expect(frames).toHaveLength(1);
    // The frame callback sees the reader mid-gesture and defers.
    const run = frames.shift()!;
    run();
    expect(ran).toEqual([]);
  });

  test("the queue resumes once the reader stops", () => {
    let busy = true;
    const h = harness(12, () => busy);
    const ran: number[] = [];
    h.queue.enqueue(() => ran.push(1));
    h.flush();
    expect(ran).toEqual([]);
    busy = false;
    // A retry is armed by the deferred frame; the harness runs it.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        // The retry calls schedule(), which asks for a frame again.
        if (h.frames.length > 0) h.flush();
        expect(ran).toEqual([1]);
        resolve();
      }, 200);
    });
  });

  test("without a quiet predicate the queue behaves as before", () => {
    const h = harness(12);
    const ran: number[] = [];
    h.queue.enqueue(() => ran.push(1));
    h.flush();
    expect(ran).toEqual([1]);
  });

  test("a long pause keeps one wake-up, not one per enqueue", () => {
    // The freeze: during a scroll every arriving row enqueued a job, the frame
    // callback deferred, and the timer it armed was overwritten by the next
    // one while the old timer stayed alive. Hundreds of timers each woke a
    // frame that armed another, and the window stopped answering input.
    //
    // Fake timers make the shape countable: at most one frame may be pending
    // and at most one timer may be armed, however many jobs arrive.
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const timers = new Map<number, () => void>();
    let nextId = 1;
    globalThis.setTimeout = ((cb: () => void) => {
      const id = nextId++;
      timers.set(id, cb);
      return id;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
      timers.delete(id);
    }) as unknown as typeof clearTimeout;
    try {
      let busy = true;
      const h = harness(12, () => busy);
      const ran: number[] = [];
      for (let i = 0; i < 200; i++) h.queue.enqueue(() => ran.push(i));
      expect(h.frames.length).toBeLessThanOrEqual(1);
      h.flush();
      expect(timers.size).toBe(1);
      // More jobs arrive between wake-ups, as they do while scrolling.
      for (let round = 0; round < 50; round++) {
        h.queue.enqueue(() => ran.push(round));
        // Never more than one frame plus one timer in flight, however many
        // jobs arrive. The old queue let both grow with every enqueue.
        expect(h.frames.length + timers.size).toBeLessThanOrEqual(2);
        expect(timers.size).toBeLessThanOrEqual(1);
        const [id, wake] = [...timers.entries()][0]!;
        timers.delete(id);
        wake();
        expect(h.frames.length).toBeLessThanOrEqual(1);
        h.flush();
        expect(timers.size).toBeLessThanOrEqual(1);
      }
      expect(ran).toEqual([]);
      // The reader stops: the next wake actually runs the queue.
      busy = false;
      const [id, wake] = [...timers.entries()][0]!;
      timers.delete(id);
      wake();
      h.flush();
      expect(ran.length).toBeGreaterThan(0);
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  });
});
