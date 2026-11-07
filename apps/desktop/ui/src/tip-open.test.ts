import { describe, expect, test } from "bun:test";
import { createOpenLabel } from "./tip-open";

/**
 * One open label at a time.
 *
 * The browser re-runs its hit test after a scroll and fires `mouseenter` for
 * whatever landed under the pointer, and the pointer never moved — so nothing
 * closed the label that was open. Every open label follows its trigger in a
 * frame loop that measures it, so a scroll through a transcript full of tips
 * left a loop behind for every row the pointer passed over. The main thread,
 * which is what the pointer's shape is drawn from, then stopped keeping up
 * with the reader: the pointer stopped changing until the thread freed.
 */
describe("the open label", () => {
  test("a label that opens closes the one that was open", () => {
    const open = createOpenLabel();
    let first = 0;
    let second = 0;
    open.claim(() => first++);
    open.claim(() => second++);
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  test("a label that opens twice does not close itself", () => {
    const open = createOpenLabel();
    let closed = 0;
    const close = () => closed++;
    open.claim(close);
    open.claim(close);
    expect(closed).toBe(0);
  });

  test("a label that ends itself gives the slot up", () => {
    const open = createOpenLabel();
    let first = 0;
    let second = 0;
    const close = () => {
      first++;
      open.release(close);
    };
    open.claim(close);
    close();
    // The slot is free, so the next label does not close a label that is
    // already closed.
    open.claim(() => second++);
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  test("releasing a label that does not hold the slot leaves it alone", () => {
    const open = createOpenLabel();
    let first = 0;
    const close = () => first++;
    open.claim(close);
    open.release(() => {});
    // The slot still belongs to the first label, so the next claim closes it.
    open.claim(() => {});
    expect(first).toBe(1);
  });
});
