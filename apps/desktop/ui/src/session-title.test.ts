import { describe, expect, test } from "bun:test";

/**
 * `i18n` stamps `document.documentElement.lang` while its module is evaluated,
 * and the test runtime has no DOM — same stand-in as transcript-format.test.ts.
 */
const globals = globalThis as { document?: Document };
globals.document ??= { documentElement: {} } as Document;

const { locale, setLocale } = await import("./i18n");
const { displayTitle } = await import("./session-title");

function withLocale(lang: "zh" | "en", body: () => void): void {
  const previous = locale();
  setLocale(lang);
  try {
    body();
  } finally {
    setLocale(previous);
  }
}

/** The expected `MM-DD HH:mm` for an ISO stamp, in whatever TZ the test runs. */
function localWhen(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe("displayTitle", () => {
  test("empty and missing titles stay missing", () => {
    expect(displayTitle(undefined)).toBeUndefined();
    expect(displayTitle(null)).toBeUndefined();
    expect(displayTitle("")).toBeUndefined();
    expect(displayTitle("   ")).toBeUndefined();
  });

  test("a generated title renders as its local start time", () => {
    const raw = "New session - 2026-10-14T14:48:58.578Z";
    withLocale("en", () => {
      expect(displayTitle(raw)).toBe(`New session · ${localWhen("2026-10-14T14:48:58.578Z")}`);
    });
    withLocale("zh", () => {
      expect(displayTitle(raw)).toBe(`新会话 · ${localWhen("2026-10-14T14:48:58.578Z")}`);
    });
  });

  test("a generated title with an unparsable date passes through", () => {
    expect(displayTitle("New session - 2026-99-99T99:99")).toBe("New session - 2026-99-99T99:99");
  });

  test("real titles — even ones that merely start alike — pass through", () => {
    expect(displayTitle("Fix the flaky sidebar test")).toBe("Fix the flaky sidebar test");
    expect(displayTitle("New session notes")).toBe("New session notes");
    expect(displayTitle("new session")).toBe("new session");
  });
});
