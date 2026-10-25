import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/** The body of one glyph in icons.tsx, up to the next glyph. */
function branch(src: string, name: string): string {
  const at = src.indexOf(`name === "${name}"`);
  expect(at).toBeGreaterThan(-1);
  const next = src.indexOf("if (name ===", at + 10);
  return src.slice(at, next === -1 ? src.length : next);
}

/**
 * The two buttons that fold the window's two sides.
 *
 * They are a pair: one folds the session list away on the left, the other the
 * drawer away on the right. They did not look like a pair — the left one drew
 * a solid block in its column and the right one a single hairline, so the
 * same action wore two different weights, and the heavier one sat in the
 * window's corner where everything else is quiet.
 *
 * The lit state stays different on purpose. The right panel is optional, so
 * saying "it is open" is worth a mark; the session list is open by default,
 * and a button that is always lit is not a state, it is furniture.
 */
describe("the two fold buttons are one pair", () => {
  const icons = read("icons.tsx");
  const chrome = read("chrome.tsx");
  const detail = read("session-detail.tsx");

  test("both are outlines with one divider, and neither is filled", () => {
    const left = branch(icons, "panel-left");
    const right = branch(icons, "panel-right");
    expect(left).not.toContain('fill="currentColor"');
    expect(right).not.toContain('fill="currentColor"');
    expect(left).toContain("M6.4 3v10");
    expect(right).toContain("M9.6 3v10");
  });

  test("the right one is the left one mirrored", () => {
    const left = branch(icons, "panel-left");
    const right = branch(icons, "panel-right");
    // The same window, drawn twice.
    expect(left).toContain('x="2.5" y="3" width="11" height="10"');
    expect(right).toContain('x="2.5" y="3" width="11" height="10"');
    // The column is the same width on both sides: 3.9px from the near edge.
    expect(6.4 - 2.5).toBeCloseTo(13.5 - 9.6, 5);
  });

  test("they are drawn at the same size", () => {
    // The header row draws its toggles at 18px; the corner has to match, or
    // the same button weighs two different amounts across one window.
    expect(chrome).toContain('<Icon name="panel-left" class="size-4.5" />');
    expect(detail).toContain('<Icon name="panel-right" />');
    // The magnifier beside the corner's switch follows it, so the corner keeps
    // one weight of its own.
    expect(chrome).toContain('<Icon name="search" class="size-4.5" />');
  });

  test("only the optional side lights up", () => {
    // The drawer is worth announcing; the session list is open by default, so
    // a ring around its switch would be lit from morning to night.
    expect(detail).toContain("toggleClasses(props.on)");
    expect(chrome).not.toContain("toggleClasses");
  });
});
