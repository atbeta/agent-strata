import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/**
 * The copy chip on a fenced block.
 *
 * Reading code is the thing this app is for, and taking a piece of it away was
 * the one action a message could not offer: the tool wells had a copy button,
 * the code the model wrote in prose did not. The chip itself is small; the
 * decisions holding it up are not, and each one fails in a way no screenshot
 * would show.
 *
 * It is built as a DOM node rather than a component because a message is
 * injected as HTML, so the click has to be routed from the message root and
 * the text has to come from the code element. It is built *after* the HTML is
 * cached, because a label frozen into that cache outlives a language switch.
 * And it sits on a wrapper because the `pre` is the horizontal scroller. These
 * hold the four places that can quietly break.
 */
describe("a fenced block can be taken away", () => {
  const md = read("md.tsx");
  const css = read("theme.css");

  test("the chip is added to a paint, not to the cached html", () => {
    // A chip written into the cache keeps saying 复制 after the reader switches
    // to English, and every replay of that message carries it. The label is
    // chrome: it is read while the nodes are built, so it must not survive as
    // cached markup.
    const parse = md.slice(md.indexOf("function parsed("), md.indexOf("function fixAutolinkTails"));
    expect(parse).not.toContain("decorateCodeBlocks");
    const paint = md.slice(md.indexOf("function nodesFrom("), md.indexOf("export function warmMarkdown"));
    expect(paint).toContain("decorateCodeBlocks(content)");
  });

  test("a diagram fence is left alone", () => {
    // A diagram's `pre` is hidden and replaced by the drawing. A chip over the
    // picture would copy source the reader is not being shown.
    expect(md).toMatch(/if \(isDiagramBlock\(pre\)\) continue;/);
  });

  test("an anonymous fence still gets the header the chip sits in", () => {
    // The strip is drawn by `pre[data-lang]::before`. Without the empty
    // attribute an unnamed fence has no strip, and the chip lands on top of its
    // first line of code — over the text it exists to copy.
    expect(md).toContain('pre.setAttribute("data-lang", "")');
  });

  test("the click is routed from the message root", () => {
    // Markdown arrives as HTML: there is no component behind the button to
    // receive its click, so the message root routes it the way it routes a
    // path link.
    expect(md).toContain('closest<HTMLElement>("[data-code-copy]")');
    expect(md).toContain("copyCode(chip)");
  });

  test("the source is the code element, not the block", () => {
    // The chip is a sibling of the `pre`; text scraped off the block would be
    // fine today and would pick up the button's own label the first time the
    // wrapper's shape changed.
    expect(md).toContain('pre.querySelector("code") ?? pre');
  });

  test("the chip is pinned outside the scroller and hidden until asked for", () => {
    // Inside the `pre` it would scroll away with a long line; visible at rest
    // it would put a button on every code block in every message.
    expect(css).toContain(".md .code-block > pre");
    expect(css).toMatch(/\.md \.code-copy \{[^}]*opacity: 0;/s);
    expect(css).toMatch(/\.md \.code-block:hover \.code-copy/);
  });
});
