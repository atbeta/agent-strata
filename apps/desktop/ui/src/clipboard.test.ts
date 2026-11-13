import { describe, expect, test } from "bun:test";
import { decodeDataUrl } from "./clipboard";

/**
 * A data URL has to be read without `fetch`.
 *
 * The shell's CSP allows `data:` and `blob:` for `img-src` only; `connect-src`
 * names the loopback origins and nothing else. Chromium enforces that for
 * `fetch`, so every copy of an image went through the request, failed, and
 * landed on the address fallback — a base64 paragraph on the clipboard.
 * WebKit does not police data URLs that way, which is why the same code looked
 * correct on macOS. These tests pin the decode that replaced the request.
 */
describe("decoding a data URL", () => {
  const PNG_1X1 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  test("base64 bytes come back with their own mime type", async () => {
    const blob = decodeDataUrl(`data:image/png;base64,${PNG_1X1}`);
    expect(blob).toBeDefined();
    expect(blob!.type).toBe("image/png");
    const bytes = new Uint8Array(await blob!.arrayBuffer());
    // A PNG signature is the cheapest proof that the bytes were not mangled.
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.length).toBeGreaterThan(50);
  });

  test("a charset parameter does not become part of the type", async () => {
    const blob = decodeDataUrl("data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E");
    expect(blob!.type).toBe("image/svg+xml");
    expect(await blob!.text()).toBe("<svg/>");
  });

  test("percent-encoded bodies decode instead of staying escaped", async () => {
    const blob = decodeDataUrl("data:text/plain,%E4%BD%A0%E5%A5%BD");
    expect(await blob!.text()).toBe("你好");
  });

  test("no mime type falls back to the generic one", () => {
    expect(decodeDataUrl("data:,abc")!.type).toBe("application/octet-stream");
  });

  test("a url that is not a data URL is left to the caller", () => {
    // The shell serves workspace files over loopback, which `connect-src`
    // does allow — those keep going through fetch.
    expect(decodeDataUrl("http://127.0.0.1:7700/files/a.png")).toBeUndefined();
    expect(decodeDataUrl("blob:http://127.0.0.1:9/abc")).toBeUndefined();
  });

  test("a malformed payload is undefined, not a throw", () => {
    // The copy falls back to the address; it must not take the click down.
    expect(decodeDataUrl("data:image/png;base64,!!!not-base64!!!")).toBeUndefined();
    expect(decodeDataUrl("data:image/png")).toBeUndefined();
  });
});
