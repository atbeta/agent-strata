import { describe, expect, test } from "bun:test";
import { externalUrlFor, isOpenableUrl } from "./external-link";

/**
 * Clicking a link emptied the window.
 *
 * Every link was a bare `<a target="_blank">`, and in a Tauri webview
 * `target="_blank"` is not a new window — it is a navigation the webview
 * satisfies itself. On Windows that is a WebView2 instance inside the same
 * window frame, with the app's page gone from it, so the window was left showing
 * nothing at all. No address bar, no back, no way back to the conversation.
 *
 * These are the two decisions that prevent it: which URLs the OS may be asked
 * to open, and which ones are the app walking to itself.
 */
describe("what may be handed to the browser", () => {
  test("web addresses and mail are the OS's business", () => {
    expect(isOpenableUrl("https://opencode.ai")).toBe(true);
    expect(isOpenableUrl("http://127.0.0.1:7700/health")).toBe(true);
    expect(isOpenableUrl("mailto:someone@example.com")).toBe(true);
  });

  test("a protocol-relative address is a web address", () => {
    // It inherits the page's scheme, which inside a webview is `tauri:` — so
    // it has to be resolved rather than passed through as written.
    expect(isOpenableUrl("//example.com/docs")).toBe(true);
    expect(externalUrlFor("//example.com/docs", "http://localhost:5178/")).toBe(
      "https://example.com/docs",
    );
  });

  test("a scheme nobody thought of is refused, which is the point", () => {
    // The reason this is a whitelist. A model can be talked into writing
    // `[click me](javascript:...)` into a reply; a blacklist has to be
    // extended after the next scheme is found, and a whitelist refuses
    // everything unrecognised without anyone deciding to.
    expect(isOpenableUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableUrl("JavaScript:alert(1)")).toBe(false);
    expect(isOpenableUrl("  javascript:alert(1)")).toBe(false);
    expect(isOpenableUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isOpenableUrl("vbscript:msgbox(1)")).toBe(false);
    expect(isOpenableUrl("file:///C:/Windows/System32/calc.exe")).toBe(false);
    // The app's own scheme must never be re-opened into a new window either.
    expect(isOpenableUrl("tauri://localhost")).toBe(false);
  });

  test("nothing at all is not a link", () => {
    expect(isOpenableUrl(undefined)).toBe(false);
    expect(isOpenableUrl(null)).toBe(false);
    expect(isOpenableUrl("")).toBe(false);
  });
});

describe("what is the app walking to itself", () => {
  const here = "http://localhost:5178/index.html";

  test("a hash route stays in the webview", () => {
    // Handing `#/session/xyz` to the OS would open a browser tab pointed at a
    // hash on the dev origin — not what the reader clicked.
    expect(externalUrlFor("#/session/xyz", here)).toBeNull();
    expect(externalUrlFor("#", here)).toBeNull();
  });

  test("the same page by another spelling stays in the webview", () => {
    expect(externalUrlFor("http://localhost:5178/index.html#/session/xyz", here)).toBeNull();
  });

  test("a different page on the same origin is a real destination", () => {
    // The page the reader is on is not a reason to refuse every link to the
    // same host — that would make docs and issues on a localhost preview
    // unopenable.
    expect(externalUrlFor("http://localhost:5178/docs", here)).toBe(
      "http://localhost:5178/docs",
    );
  });

  test("anything refused never reaches the opener", () => {
    expect(externalUrlFor("javascript:alert(1)", here)).toBeNull();
    expect(externalUrlFor("data:text/html,x", here)).toBeNull();
    expect(externalUrlFor("file:///etc/passwd", here)).toBeNull();
  });
});
