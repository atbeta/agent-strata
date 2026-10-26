import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dir, "icons.tsx"), "utf8");

/**
 * `Glyph` draws on a 16 grid with a 1.5 pen. A glyph lifted from an icon library
 * comes on a 24 grid and is reproduced verbatim, which is the right call — a
 * re-fit is a redraw, and a redraw is how the pushpin came to read as a speck.
 *
 * But scaling the drawing down by 16/24 scales the pen with it, so a library
 * stroke kept at 1.5 renders at 1.0 and the glyph reads lighter than every mark
 * drawn beside it on the same row. Export looked like a hair next to the
 * terminal and the trace icon.
 *
 * So the weight travels with the geometry. 1.5 × 24/16 = 2.25, which puts a
 * 24-grid library mark back at the visual weight of our own.
 */
describe("a glyph's pen is scaled with its grid", () => {
  test("every 24-grid glyph carries the widened pen", () => {
    const uses24 = src.match(/<Glyph class=\{cls\} box="0 0 24 24"[^>]*>/g) ?? [];
    expect(uses24.length).toBeGreaterThan(0);
    for (const use of uses24) {
      expect(use, `24-grid glyph without a weight: ${use}`).toContain('weight="2.25"');
    }
  });

  test("the 16 grid keeps the weight it was drawn with", () => {
    // 1.5 is what the hand-drawn marks in this file are stroked with. Widening
    // it would be the same mistake in the other direction.
    expect(src).toContain('stroke-width={props.weight ?? "1.5"}');
    // And nothing opts into a weight without also leaving the 16 grid, which
    // would be a 16-grid mark drawn too heavy for its neighbours.
    const widened = src.match(/<Glyph(?![^>]*box=)[^>]*weight=/g) ?? [];
    expect(widened).toEqual([]);
  });

  test("the header plug keeps its height without reading narrower than its neighbours", () => {
    const at = src.indexOf('if (name === "plug")');
    const plug = src.slice(at, src.indexOf('if (name === "mcp")', at));
    expect(plug).toContain("M20 7v5a8 8 0 0 1-16 0V7Z");
    expect(plug).toContain("M12 21v-1");
    expect(plug).toContain('weight="2.25"');
  });

  test("every header icon sits in the same fixed flex box", () => {
    const toggle = readFileSync(join(import.meta.dir, "header-toggle.tsx"), "utf8");
    expect(toggle).toContain("inline-flex size-4.5 items-center justify-center");
  });
});
