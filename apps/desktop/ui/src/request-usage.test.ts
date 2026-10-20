import { describe, expect, test } from "bun:test";
import { requestParts } from "./request-usage";

describe("requestParts", () => {
  test("splits a cached request into the shares the backend reported", () => {
    const usage = { input: 504, cache_read: 322_812, cache_write: 0, output: 400, reasoning: 104 };
    const parts = requestParts(usage, 323_820);
    expect(parts.map((p) => p.key)).toEqual(["cache_read", "input", "output", "reasoning"]);
    expect(parts.map((p) => p.tokens)).toEqual([322_812, 504, 400, 104]);
    // The rounded percents still describe the whole request.
    expect(parts.reduce((sum, p) => sum + p.percent, 0)).toBeCloseTo(100, 0);
    expect(parts[0].percent).toBeCloseTo(99.7, 1);
  });

  test("parts that reported zero are dropped, keeping the given order", () => {
    const usage = { input: 30, cache_read: 0, cache_write: 20, output: 50, reasoning: 0 };
    expect(requestParts(usage, 100).map((p) => p.key)).toEqual(["cache_write", "input", "output"]);
  });

  test("no reported total means no parts", () => {
    const usage = { input: 10, cache_read: 0, cache_write: 0, output: 0, reasoning: 0 };
    expect(requestParts(usage, 0)).toEqual([]);
    expect(requestParts(usage, -5)).toEqual([]);
  });
});
