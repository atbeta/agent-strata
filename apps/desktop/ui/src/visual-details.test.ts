import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");

describe("visual details", () => {
  test("trend days use the named type scale and expose their values to focus and screen readers", () => {
    const source = read("fleet-view.tsx");
    const chart = source.slice(source.indexOf("function TrendChart"), source.indexOf("function labelled"));
    expect(chart).not.toContain("text-[10px]");
    expect(chart).toContain("text-2xs");
    expect(chart).toContain("tabIndex={0}");
    expect(chart).toContain('role="img"');
    expect(chart).toContain("aria-label={label}");
    expect(chart).not.toContain("text-muted-foreground/60");
  });

  test("fleet responds to the main column and names its rank radio group", () => {
    const source = read("fleet-view.tsx");
    expect(source).toContain("@min-[768px]/main:grid-cols-[minmax(0,1fr)_minmax(16rem,20rem)]");
    expect(source).toContain("@min-[640px]/main:grid-cols-4");
    expect(source).toContain("@max-[767px]/main:border-t");
    expect(source).toContain('kind="radio"');
    expect(source).toContain('label={t("fleet.rank")}');
    expect(source).not.toContain("md:grid-cols");
    expect(source).not.toContain("sm:grid-cols");
  });

  test("fleet status groups expand and usage failures preserve honest data", () => {
    const source = read("fleet-view.tsx");
    expect(source).toContain("aria-expanded={expanded()}");
    expect(source).toContain('t("fleet.status.all"');
    expect(source).toContain('t("fleet.status.less")');
    expect(source).toContain("const buckets = () => lastBuckets();");
    expect(source).toContain("setLastBuckets(rows)");
    expect(source).toContain("refetch: refetchDaily");
    expect(source).toContain('title={t("fleet.usage.failed")}');
    expect(source).toContain('t("fleet.usage.stale")');
  });

  test("fleet process failures stay visible without discarding the last result", () => {
    const source = read("fleet-dev.tsx");
    expect(source).toContain("lastProcesses().filter");
    expect(source).toContain("setLastProcesses(rows)");
    expect(source).toContain("live().length > 0 || processes.error");
    expect(source).toContain('title={t("fleet.dev.failed")}');
    expect(source).toContain('t("fleet.dev.stale")');
    expect(source).not.toContain(".catch(() => []");
  });

  test("compare uses shared states and stacks both two-column grids in the main container", () => {
    const source = read("compare.tsx");
    expect(source).not.toContain("<main");
    expect(source).toContain('fallback={<EmptyState icon="activity" title={t("compare.loading")} />}');
    expect(source).toContain("onClick={() => void refetch()}");
    expect(source).toContain("when={c().turn_pairs.length > 0}");
    expect(source.match(/@min-\[560px\]\/main:grid-cols-2/g)).toHaveLength(2);
    expect(source).toContain("break-words");
  });

  test("first paint applies the same content preferences and CJK font fallbacks", () => {
    const source = readFileSync(join(import.meta.dir, "../index.html"), "utf8");
    expect(source).toContain("root.dataset.contentSize = fonts.size");
    expect(source).toContain('root.style.setProperty("--content-size", sizes[fonts.size])');
    expect(source).toContain("root.dataset.codeLeading = fonts.leading");
    expect(source).toContain('root.style.setProperty("--code-leading", leads[fonts.leading])');
    expect(source).toContain('root.dataset.codeLigatures = "off"');
    expect(source).toContain('"PingFang SC"');
    expect(source).toContain('"Noto Sans Mono CJK SC"');
    expect(source).not.toContain("root.dataset.codeSize");
    expect(source).toContain(String.raw`/^[\p{L}\p{N} ._-]+$/u`);
  });
});
