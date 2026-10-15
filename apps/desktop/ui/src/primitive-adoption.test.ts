import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A ratchet on hand-styled interactive elements.
 *
 * The shell reads as provisional when neighbouring controls disagree about
 * padding, radius, hover shade and focus ring — and it did, because nothing
 * stopped each screen from writing its own. DESIGN.md says "do not add a second
 * styling path", which is advice; advice does not fail a build.
 *
 * This fails the build instead. The budget only ever moves down, and lowering it
 * is part of finishing any screen that converts its controls: a screen that
 * moved 9 buttons onto `Button` lowers the number by 9 in the same commit. A
 * screen that adds 3 while leaving the rest in place does not lower it, and the
 * count going up is the signal that the set is growing again.
 *
 * `components/ui` is excluded — that is where a primitive is allowed to render
 * its own element.
 */
/**
 * Every one of these ten is a deliberate exception, not an oversight:
 *
 *   settings-blocks.tsx x2  `Segmented` and `PillGroup` — these *are* the
 *                           settings-block definitions. They are what the other
 *                           screens are being converted onto.
 *   chrome.tsx              `CaptionButton` — has to fill a 44px title bar and
 *                           sit square against the window edge.
 *   trace.tsx x3            a timeline mark (absolute, opacity-driven) and two
 *                           20x16 scroll arrows pinned to the scroll container.
 *   review.tsx              a diff cell whose own background carries the
 *                           add/del colour; the button is only the click target.
 *   json-view.tsx           a 14px tree caret, below the smallest size the
 *                           ladder offers.
 *   prompt-navigator.tsx    the transcript tick, styled by `.nav-tick`.
 *   composer-menu.tsx       a 16px round removal badge on an attachment chip.
 *
 * Adding an eleventh means adding a reason, not a conversion.
 */
const BUDGET = { button: 10, input: 21 };

const SRC = import.meta.dir;
const PRIMITIVES = join(SRC, "components", "ui");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(path));
    else if (entry.name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/** Every .tsx under src, minus the primitive set itself. */
function screenFiles(): string[] {
  return tsxFiles(SRC).filter((f) => !f.startsWith(PRIMITIVES));
}

function countIn(files: string[], tag: string): number {
  let n = 0;
  for (const file of files) n += readFileSync(file, "utf8").split(`<${tag}`).length - 1;
  return n;
}

describe("primitive adoption", () => {
  const files = screenFiles();

  test("the screen set is walked", () => {
    // Guards the walker itself: if the glob silently matched nothing, every
    // count below would be zero and the ratchet would pass forever.
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith(join("src", "App.tsx")))).toBe(true);
    expect(files.some((f) => f.includes(`${join("components", "ui")}`))).toBe(false);
  });

  test(`raw <button> outside components/ui stays at or under ${BUDGET.button}`, () => {
    const found = countIn(files, "button");
    // The floor is a backstop against a vacuous pass, not a convergence
    // target. The test above already proves the walker sees the screen set and
    // App.tsx specifically; this only catches the case where the screen files
    // have all but vanished from `src`. It has to stay low, because pinning it
    // near the real count would make finishing the job a test failure.
    expect(found).toBeGreaterThanOrEqual(3);
    expect(found).toBeLessThanOrEqual(BUDGET.button);
  });

  test(`raw <input> outside components/ui stays at or under ${BUDGET.input}`, () => {
    const found = countIn(files, "input");
    expect(found).toBeGreaterThan(0);
    expect(found).toBeLessThanOrEqual(BUDGET.input);
  });
});
