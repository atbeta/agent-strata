import { describe, expect, test } from "bun:test";
import { fmtBytes } from "./bytes";

describe("a byte count as a person would say it", () => {
  test("whole bytes take no decimal", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1)).toBe("1 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1023)).toBe("1023 B");
  });

  test("one decimal below ten, none above", () => {
    // "9.4 KB" reads as a measurement; "9 KB" and "9.375 KB" read as a guess
    // and a spew.
    expect(fmtBytes(1024)).toBe("1.0 KB");
    expect(fmtBytes(1024 * 9.4)).toBe("9.4 KB");
    expect(fmtBytes(1024 * 10)).toBe("10 KB");
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  test("the units climb and stop at GB", () => {
    expect(fmtBytes(1024 ** 2)).toBe("1.0 MB");
    expect(fmtBytes(1024 ** 3)).toBe("1.0 GB");
    expect(fmtBytes(1024 ** 4)).toBe("1024 GB");
  });

  test("a nonsense count is not a number to print", () => {
    expect(fmtBytes(-1)).toBe("0 B");
    expect(fmtBytes(Number.NaN)).toBe("0 B");
    expect(fmtBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});
