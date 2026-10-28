import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A button is an inline-flex box with its label centred in it. `truncate` on
 * the button therefore does not do what it does on a block: the label is one
 * flex item, it overflows the box on both sides, and `overflow: hidden` cuts
 * it at both ends with no ellipsis anywhere. A long session name came out
 * with its first characters missing as well as its last.
 *
 * The ellipsis belongs on the label — a span inside the button, which is a
 * block the browser can ellipsize. This test holds that line: no button
 * truncates itself.
 */
describe("a button never truncates its own label", () => {
  const files = readdirSync(import.meta.dir, { recursive: true })
    .map((f) => String(f))
    .filter((f) => f.endsWith(".tsx"));

  test("every button leaves the ellipsis to its label", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      for (const m of src.matchAll(/<Button\b[^>]*>/g)) {
        const cls = /class="([^"]*)"/.exec(m[0])?.[1] ?? "";
        if (cls.includes("truncate")) offenders.push(`${file}: ${cls}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
