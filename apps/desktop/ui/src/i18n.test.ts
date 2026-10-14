import { describe, expect, test } from "bun:test";
import { compactNum, locale, num, setLocale } from "./i18n";

/** Run `body` in `lang`, then hand the window back the language it had. */
function withLocale(lang: "zh" | "en", body: () => void): void {
  const previous = locale();
  setLocale(lang);
  try {
    body();
  } finally {
    setLocale(previous);
  }
}

describe("a figure in a stat tile", () => {
  test("keeps its digits while they are the honest answer", () => {
    // A glance reads "twenty seven" or "four thousand"; rounding either of
    // those would only cost accuracy.
    expect(compactNum(27)).toBe(num(27));
    expect(compactNum(4169)).toBe(num(4169));
    expect(compactNum(99_999)).toBe(num(99_999));
  });

  test("stops counting digits once there are too many to glance at", () => {
    withLocale("en", () => {
      expect(compactNum(10_249_497)).toBe("10.2M");
      expect(compactNum(1_234_567)).toBe("1.2M");
    });
  });

  test("compacts in the window's language, not in the author's", () => {
    // Chinese reads ten million as 1024.9万, not as 10.2M.
    withLocale("zh", () => {
      expect(compactNum(10_249_497)).toBe("1024.9万");
    });
    withLocale("en", () => {
      expect(compactNum(10_249_497)).toBe("10.2M");
    });
  });

  test("a figure that is not a number reads as zero", () => {
    expect(compactNum(Number.NaN)).toBe(num(0));
  });
});
