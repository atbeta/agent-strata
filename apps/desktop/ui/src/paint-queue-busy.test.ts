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
});
