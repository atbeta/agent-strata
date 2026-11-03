import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createDebouncer } from "./debounce";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("debounced tasks", () => {
  test("only the latest scheduled task runs", async () => {
    const calls: string[] = [];
    const dispose = createRoot((dispose) => {
      const debounce = createDebouncer(15);
      debounce.schedule(() => calls.push("old"));
      debounce.schedule(() => calls.push("new"));
      return dispose;
    });

    await wait(40);
    expect(calls).toEqual(["new"]);
    dispose();
  });

  test("cancel drops the pending task", async () => {
    let called = false;
    const dispose = createRoot((dispose) => {
      const debounce = createDebouncer(15);
      debounce.schedule(() => {
        called = true;
      });
      debounce.cancel();
      return dispose;
    });

    await wait(40);
    expect(called).toBe(false);
    dispose();
  });

  test("disposing the owner clears the pending timer", async () => {
    let called = false;
    const dispose = createRoot((dispose) => {
      createDebouncer(15).schedule(() => {
        called = true;
      });
      return dispose;
    });

    dispose();
    await wait(40);
    expect(called).toBe(false);
  });
});
