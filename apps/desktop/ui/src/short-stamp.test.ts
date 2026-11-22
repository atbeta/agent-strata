import { describe, expect, test } from "bun:test";
import { setLocale, shortStamp } from "./i18n";

// The assertions are written against the zh face (24-hour clock); the app
// default is zh, but a sibling file may have left another locale behind.
setLocale("zh");

describe("shortStamp", () => {
  const now = new Date(2026, 10, 22, 18, 0);

  test("today reads as a bare time", () => {
    const s = shortStamp(new Date(2026, 10, 22, 14, 32), now);
    expect(s).toContain("14:32");
    expect(s).not.toContain("11");
  });

  test("earlier this year adds the day, not the year", () => {
    const s = shortStamp(new Date(2026, 10, 20, 14, 32), now);
    expect(s).toContain("14:32");
    expect(s).toContain("11");
    expect(s).toContain("20");
    expect(s).not.toContain("2026");
  });

  test("another year keeps the year", () => {
    const s = shortStamp(new Date(2025, 10, 20, 14, 32), now);
    expect(s).toContain("2025");
  });
});
