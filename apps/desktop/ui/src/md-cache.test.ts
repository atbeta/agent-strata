import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MarkdownHtmlCache } from "./md-cache";

describe("settled markdown HTML cache", () => {
  test("replays only the exact source", () => {
    const cache = new MarkdownHtmlCache();
    cache.set("hello", "<p>hello</p>");
    expect(cache.get("hello")).toBe("<p>hello</p>");
    expect(cache.get("hello!")).toBeUndefined();
  });

  test("a hit refreshes an entry in the LRU", () => {
    const cache = new MarkdownHtmlCache(2, 100);
    cache.set("a", "A");
    cache.set("b", "B");
    expect(cache.get("a")).toBe("A");
    cache.set("c", "C");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.get("c")).toBe("C");
  });

  test("total cost and entry count both stay bounded", () => {
    const byCost = new MarkdownHtmlCache(10, 10);
    byCost.set("a", "12345");
    byCost.set("b", "12345");
    expect(byCost.size).toBe(1);
    expect(byCost.totalCost).toBe(6);
    expect(byCost.get("a")).toBeUndefined();
    expect(byCost.get("b")).toBe("12345");

    const byCount = new MarkdownHtmlCache(1, 100);
    byCount.set("a", "A");
    byCount.set("b", "B");
    expect(byCount.size).toBe(1);
    expect(byCount.get("a")).toBeUndefined();
  });

  test("an oversized entry is not retained", () => {
    const cache = new MarkdownHtmlCache(10, 5);
    cache.set("source", "<p>too large</p>");
    expect(cache.size).toBe(0);
    expect(cache.totalCost).toBe(0);
  });

  test("replacing a source releases its old cost", () => {
    const cache = new MarkdownHtmlCache(10, 100);
    cache.set("a", "1234");
    cache.set("a", "x");
    expect(cache.size).toBe(1);
    expect(cache.totalCost).toBe(2);
    expect(cache.get("a")).toBe("x");
  });

  test("streaming bypasses the cache and diagrams still draw on new nodes", () => {
    const src = readFileSync(join(import.meta.dir, "md.tsx"), "utf8");
    expect(src).toContain("nodesFrom(stable.slice(renderedStable.length), true, !live)");
    expect(src).toContain("nodesFrom(tail, false, !live)");
    expect(src).toContain("useCache ? htmlCache.get(markdown) : undefined");
    expect(src.indexOf("if (finished) drawDiagrams")).toBeGreaterThan(src.indexOf("htmlCache.set"));
  });
});
