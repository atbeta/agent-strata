import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (f: string) => readFileSync(join(import.meta.dir, f), "utf8");

/**
 * The tooltip's pointer listener, which leaked once per tooltip ever hovered.
 *
 * It was installed in the `onMouseEnter` and `onFocusIn` handlers and removed
 * only by `onCleanup` at unmount, while `hide()` — the thing that actually ends
 * a hover — only cleared the anchor. So a transcript full of tooltips kept one
 * capture-phase `pointermove` listener per tooltip on the document, and every
 * mouse move anywhere in the app ran all of them. Scrolling mounted more rows
 * carrying more tips, which is why it got worse the further the reader went and
 * why the composer felt slow even though it was nowhere near the scroll.
 *
 * There is no DOM in this suite, so this reads the source. It is a shape check,
 * not a behavioural one — but the shape is the whole bug: an add without a
 * matching remove in the same scope is how the leak was written.
 */
const src = read("tip.tsx");

describe("a tooltip's pointer listener", () => {
  test("every install has a matching removal", () => {
    const adds = src.match(/addEventListener\(/g) ?? [];
    const removes = src.match(/removeEventListener\(/g) ?? [];
    expect(adds.length).toBe(removes.length);
  });

  test("the listener is not installed by a hover handler", () => {
    // The handlers only place the bubble now. Installing there is what made the
    // listener outlive the hover while the component stayed mounted.
    const enter = src.slice(src.indexOf("onMouseEnter"), src.indexOf("onFocusOut"));
    expect(enter).not.toContain("addEventListener");
  });

  test("hide() ends the hover, so the effect can drop the listener", () => {
    expect(src).toContain("const hide = () => setAnchor(null)");
    // The listener lives in an effect keyed on the anchor: it is installed while
    // a bubble is showing and removed by the cleanup of the same effect.
    const effect = src.slice(src.indexOf("if (!anchor()) return;"));
    expect(effect).toContain("addEventListener");
    expect(effect).toContain("onCleanup(() => document.removeEventListener");
  });
});
