import { describe, expect, test } from "bun:test";
import { createLatestFrame } from "./latest-frame";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("latest frame", () => {
  test("paints the first value immediately and only the latest value in the interval", async () => {
    const calls: string[] = [];
    const frame = createLatestFrame(20, (value: string) => calls.push(value));
    frame.schedule("first");
    frame.schedule("old");
    frame.schedule("latest");

    expect(calls).toEqual(["first"]);
    await wait(40);
    expect(calls).toEqual(["first", "latest"]);
    frame.cancel();
  });

  test("cancel drops the pending value", async () => {
    const calls: string[] = [];
    const frame = createLatestFrame(20, (value: string) => calls.push(value));
    frame.schedule("first");
    frame.schedule("pending");
    frame.cancel();

    await wait(40);
    expect(calls).toEqual(["first"]);
  });
});
