import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/**
 * The window's top-left corner.
 *
 * It used to carry the wordmark and nothing else, and the two things a reader
 * reaches for — the panel that finds everything, and the switch that folds the
 * session list away — sat below it: the panel on a row in the list, the switch
 * nowhere at all.
 *
 * The corner belongs to the window, not to the list. That matters most for the
 * switch: a button that folds the sidebar away cannot live inside the thing it
 * folds, or the only way to unfold it would be to unfold it first.
 */
describe("the top-left corner of the window", () => {
  const chrome = read("chrome.tsx");
  const app = read("App.tsx");
  const sidebar = read("sidebar.tsx");

  test("the mark stands alone", () => {
    // The name still says itself where it is asked for — the window title, the
    // taskbar entry, the About panel. A second copy in the corner of every
    // window was the loud part, not the informative one.
    expect(chrome).not.toContain("APP_NAME");
  });

  test("the corner carries the window's own switches", () => {
    expect(chrome).toContain("export function TopLeftControls");
    expect(chrome).toContain("onToggleSidebar");
    expect(chrome).toContain("onOpenPalette");
    // The caption bar draws them right after the mark.
    expect(chrome).toContain("<AppMark />");
  });

  test("the list can be folded away, and the switch to unfold it is not in it", () => {
    expect(app).toContain("readSidebarOpen()");
    expect(app).toContain("writeSidebarOpen(next)");
    expect(app).toContain("when={sidebarOpen()}");
    // The folded column leaves a strip behind with the switch on it, so the
    // way back is still on screen.
    expect(app).toContain("!sidebarOpen() && !usesCustomCaption()");
  });

  test("the panel is opened from the corner, not from a row in the list", () => {
    expect(sidebar).not.toContain("onOpenSearch");
    expect(sidebar).toContain("onOpenPalette");
  });

  test("the strip a folded column leaves holds what it carries", () => {
    // The strip is one button wide and the corner carries two: the switch that
    // unfolds the column, and the palette. Side by side they are 58px of
    // buttons in a 40px strip, and the second one falls off the edge, so the
    // strip stacks them.
    const strip = app.indexOf('class="flex w-10 shrink-0 flex-col items-center gap-1');
    expect(strip).toBeGreaterThan(-1);
    const controls = app.indexOf("<TopLeftControls", strip);
    expect(controls).toBeGreaterThan(strip);
    expect(app.slice(controls, controls + 120)).toContain('class="flex-col"');
  });
});
