import { describe, expect, test } from "bun:test";
import { createPaintQueue } from "./paint-queue";

describe("paint work spread across frames", () => {
  const harness = (budgetMs: number) => {
    let clock = 0;
    const frames: Array<() => void> = [];
    const queue = createPaintQueue(
      (cb) => {
        frames.push(cb);
      },
      () => clock,
      budgetMs,
    );
    return {
      queue,
      frames,
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

  test("a heavy row uses the frame and the next row waits", () => {
    const { queue, frames, advance, flush } = harness(12);
    const ran: number[] = [];
    queue.enqueue(() => {
      advance(40);
      ran.push(1);
    });
    queue.enqueue(() => {
      advance(40);
      ran.push(2);
    });
    expect(frames).toHaveLength(1);
    flush();
    expect(ran).toEqual([1]);
    expect(frames).toHaveLength(1);
    flush();
    expect(ran).toEqual([1, 2]);
    expect(frames).toHaveLength(0);
  });

  test("cheap rows share a frame until the budget is spent", () => {
    const { queue, frames, advance, flush } = harness(12);
    const ran: number[] = [];
    for (let i = 0; i < 5; i++) {
      queue.enqueue(() => {
        advance(4);
        ran.push(i);
      });
    }
    expect(frames).toHaveLength(1);
    flush();
    // 4 + 4 + 4 = 12, so the fourth row starts the next frame.
    expect(ran).toEqual([0, 1, 2]);
    expect(frames).toHaveLength(1);
  });

  test("a cancelled row never paints", () => {
    const { queue, flush } = harness(12);
    const ran: number[] = [];
    const cancel = queue.enqueue(() => ran.push(1));
    queue.enqueue(() => ran.push(2));
    cancel();
    flush();
    expect(ran).toEqual([2]);
  });
});
