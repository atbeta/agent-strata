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
  test("every per-tip install has a matching removal", () => {
    // One listener is app-lifetime on purpose: the module-level `scroll`
    // listener that dismisses every open label. One instance is added when the
    // module loads and it is never removed, because there is exactly one app
    // and it dies with the page. Counting it as a leak would be counting the
    // fix as the bug, so the assertion is scoped to the per-tip effect.
    const perTip = src.slice(src.indexOf("if (!open()) return;"));
    const adds = perTip.match(/addEventListener\(/g) ?? [];
    const removes = perTip.match(/removeEventListener\(/g) ?? [];
    expect(adds.length).toBe(removes.length);
    expect(adds.length).toBe(1);
    // The one global install, and it is outside the per-tip effect.
    expect((src.match(/window\.addEventListener\(/g) ?? []).length).toBe(1);
  });

  test("the listener is not installed by a hover handler", () => {
    // The handlers only place the bubble now. Installing there is what made the
    // listener outlive the hover while the component stayed mounted.
    const enter = src.slice(src.indexOf("onMouseEnter"), src.indexOf("onFocusOut"));
    expect(enter).not.toContain("addEventListener");
  });

  test("hide() ends the hover, so the effect can drop the listener", () => {
    expect(src).toContain("const hide = () => setAnchor(null)");
    // The listener lives in an effect keyed on whether a bubble is showing,
    // not on its rect: following a moving trigger updates the anchor every
    // frame, and keying on the rect would tear down and reinstall the
    // listener on each one. The follow frame is cleaned up with it.
    const effect = src.slice(src.indexOf("if (!open()) return;"));
    expect(effect).toContain("addEventListener");
    expect(effect).toContain("document.removeEventListener");
    expect(effect).toContain("cancelAnimationFrame");
  });
});
