import { describe, expect, test } from "bun:test";
import { splitLinkTail } from "./link-tail";

/**
 * The parser's autolink pattern stops at whitespace, so anything written right
 * after an address without a space is taken as part of it. ASCII punctuation it
 * handles; CJK it does not. Measured on the real parser:
 *
 *   见 http://localhost:3000/。
 *   → <a href="http://localhost:3000/%E3%80%82">http://localhost:3000/。</a>
 *
 * Which is a link that goes nowhere, and a sentence with a full stop the reader
 * cannot select without dragging the address along.
 */

describe("where an autolink ends", () => {
  test("a CJK full stop comes off the address", () => {
    expect(splitLinkTail("http://localhost:3000/。")).toEqual({
      keep: "http://localhost:3000/",
      tail: "。",
    });
  });

  test("a comma and a colon do too", () => {
    expect(splitLinkTail("https://example.com/a，然后").tail).toBe("，然后");
    expect(splitLinkTail("https://example.com/a：").keep).toBe("https://example.com/a");
  });

  test("a parenthetical after the address comes off whole", () => {
    // The bug in the screenshot: the aside was inside the link, so clicking
    // the address opened a URL containing a sentence about vite.
    expect(splitLinkTail("http://localhost:3000/（vite 8 换端口后重启过）")).toEqual({
      keep: "http://localhost:3000/",
      tail: "（vite 8 换端口后重启过）",
    });
  });

  test("every bracketed pair the reader might type", () => {
    for (const [open, close] of [
      ["（", "）"],
      ["【", "】"],
      ["《", "》"],
      ["「", "」"],
      ["〔", "〕"],
    ]) {
      const text = `https://example.com/x${open}note${close}`;
      expect(splitLinkTail(text)).toEqual({ keep: "https://example.com/x", tail: `${open}note${close}` });
    }
  });

  test("a closer with no opener only takes itself off", () => {
    expect(splitLinkTail("https://example.com/x）")).toEqual({
      keep: "https://example.com/x",
      tail: "）",
    });
  });

  test("a Chinese path is part of the address and stays", () => {
    // The other half of the bug: a fix that strips CJK wholesale would break
    // real URLs that carry a translated path.
    expect(splitLinkTail("https://example.com/路径/中文")).toEqual({
      keep: "https://example.com/路径/中文",
      tail: "",
    });
  });

  test("an address that ends the sentence is untouched", () => {
    expect(splitLinkTail("http://localhost:3000/")).toEqual({
      keep: "http://localhost:3000/",
      tail: "",
    });
    expect(splitLinkTail("https://example.com/a-b_c?x=1&y=2#frag")).toEqual({
      keep: "https://example.com/a-b_c?x=1&y=2#frag",
      tail: "",
    });
  });

  test("a query string is not mistaken for punctuation", () => {
    // `?` and `:` appear in real addresses, so they may only be stripped at the
    // very end — which is what the trailing walk does, and why this asserts the
    // interior survives.
    expect(splitLinkTail("https://example.com/a?b=1:2")).toEqual({
      keep: "https://example.com/a?b=1:2",
      tail: "",
    });
  });

  test("text that is nothing but punctuation is handed back whole", () => {
    // Returning an empty address would delete the words from the page.
    expect(splitLinkTail("。。")).toEqual({ keep: "。。", tail: "" });
  });

  test("a dash between clauses comes off", () => {
    expect(splitLinkTail("https://example.com/a—后面").tail).toBe("—后面");
  });
});
