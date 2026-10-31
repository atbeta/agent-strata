import { describe, expect, test } from "bun:test";
import { createPaintQueue, firstPaint } from "./paint-queue";

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

  test("a row that scrolled into view paints before the ones still waiting", () => {
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
    const later = queue.enqueue(() => {
      advance(40);
      ran.push(3);
    });
    later.prioritize();
    expect(frames).toHaveLength(1);
    flush();
    expect(ran).toEqual([3]);
  });
});

describe("which frame a row's first paint belongs to", () => {
  test("a row mounted on screen, and a reply still being written, paint now", () => {
    expect(firstPaint({ live: false, visible: true, queued: false })).toBe("now");
    expect(firstPaint({ live: true, visible: false, queued: true })).toBe("now");
    expect(firstPaint({ live: true, visible: true, queued: false })).toBe("now");
  });

  test("a row that was waiting and then entered the view waits one frame, at the front", () => {
    expect(firstPaint({ live: false, visible: true, queued: true })).toBe("soon");
  });

  test("a row still off screen waits its turn", () => {
    expect(firstPaint({ live: false, visible: false, queued: false })).toBe("later");
    expect(firstPaint({ live: false, visible: false, queued: true })).toBe("later");
  });
});
