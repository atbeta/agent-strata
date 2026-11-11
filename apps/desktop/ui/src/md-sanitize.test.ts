import "./dom-env"; // first import: registers window/document before ./md loads
import { describe, expect, test } from "bun:test";
import { parsed } from "./md";
import { isOpenableUrl } from "./external-link";

/**
 * The only door between model text and the DOM is the pipeline in `parsed()`:
 * marked parses, DOMPurify sanitises, and three steps mutate the tree *after*
 * the sanitiser has run. These tests feed hostile markup through the whole
 * composition and assert what the rendered DOM became — not what the source
 * of any step looks like. A regression in a post-sanitise mutator (which the
 * sanitiser cannot see) is caught here the same way as one in the config.
 */
const render = (markdown: string): HTMLElement => {
  const host = document.createElement("div");
  host.append(parsed(markdown, true));
  return host;
};

const eventHandlers = (host: ParentNode): Element[] =>
  [...host.querySelectorAll("*")].filter((el) =>
    [...el.attributes].some((a) => a.name.startsWith("on")),
  );

/** Every href the pipeline emits must be one the OS handoff would accept. */
const openableHrefs = (host: ParentNode): string[] =>
  [...host.querySelectorAll("[href]")]
    .map((el) => el.getAttribute("href") ?? "")
    .filter((href) => !isOpenableUrl(href));

/**
 * An attribute whose value carries an executable scheme, wherever the parser
 * put it — `href`, `xlink:href`, `values`, `formaction`. The payload as shown
 * text is fine: `revealDroppedTags` prints rejected markup as source, so the
 * string "javascript:" on the page is only a problem when it sits in an
 * attribute the DOM can act on.
 */
const dangerousAttrValues = (host: ParentNode): string[] =>
  [...host.querySelectorAll("*")].flatMap((el) =>
    [...el.attributes]
      .filter((a) => /javascript:|data:text\/html/i.test(a.value))
      .map((a) => `${el.tagName.toLowerCase()}[${a.name}]`),
  );

describe("a reply cannot inject active markup", () => {
  test("a script block is shown as source, never mounted as an element", () => {
    const host = render("<script>alert(1)</script>");
    expect(host.querySelector("script")).toBeNull();
    // The reader still sees what was written — dropped, not swallowed.
    expect(host.textContent).toContain("alert(1)");
  });

  test("a script inside a sentence leaves the sentence and no element", () => {
    const host = render("look <script>alert(1)</script> here");
    expect(host.querySelector("script")).toBeNull();
    expect(host.textContent).toContain("look");
    expect(host.textContent).toContain("here");
  });

  test("an img keeps its src but loses onerror", () => {
    const host = render('before <img src="x.png" onerror="alert(1)"> after');
    const img = host.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("onerror")).toBeNull();
    expect(host.innerHTML).not.toContain("onerror");
  });

  test.each([
    ["<form", '<form action="//evil"><input name="p"></form>'],
    ["<iframe", '<iframe src="//evil"></iframe>'],
    ["<object", '<object data="//evil"></object>'],
    ["<embed", '<embed src="//evil">'],
    ["<button", '<button onclick="alert(1)">send</button>'],
    ["<textarea", "<textarea>seed</textarea>"],
    ["<select", "<select><option>a</option></select>"],
    ["<video", '<video src="//evil"></video>'],
    ["<audio", '<audio src="//evil"></audio>'],
  ])("%s never reaches the DOM", (_label, input) => {
    const host = render(input);
    expect(
      host.querySelector("form, iframe, object, embed, button, textarea, select, video, audio"),
    ).toBeNull();
  });

  test("javascript: links lose the href, whatever the spelling", () => {
    for (const input of [
      "[click me](javascript:alert(1))",
      '<a href="javascript:alert(1)">x</a>',
      '<a href="JaVaScRiPt:alert(1)">x</a>',
      '<a href="&#x6a;avascript:alert(1)">x</a>',
    ]) {
      const host = render(input);
      expect(host.querySelector('[href^="javascript:"]')).toBeNull();
      expect(openableHrefs(host)).toEqual([]);
    }
  });

  test("data:text/html is refused on links but data:image survives on img", () => {
    const host = render('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(host.querySelector('[href^="data:"]')).toBeNull();
    const img = render("![p](data:image/png;base64,iVBORw0KGgo=)").querySelector("img");
    expect(img?.getAttribute("src")).toMatch(/^data:image\/png/);
  });

  test("no style attribute, class, or data-* survives on reply markup", () => {
    const host = render(
      '<p style="position:fixed;inset:0;z-index:999">a</p><span class="fixed inset-0" data-path="/etc/passwd">b</span>',
    );
    expect(host.querySelector("[style]")).toBeNull();
    expect(host.querySelector("[class]")).toBeNull();
    expect(host.querySelector("[data-path]")).toBeNull();
  });

  test("a hand-written field becomes text; a GFM checkbox stays the one control", () => {
    const host = render('- [x] done\n\n<input type="text" value="seed">');
    expect(host.querySelector('input[type="checkbox"][disabled]')).not.toBeNull();
    expect(host.querySelector('input[type="text"]')).toBeNull();
  });
});

describe("mutation payloads do not reassemble into live markup", () => {
  test.each([
    ["svg onload", "<svg><g/onload=alert(1)//<svg>"],
    ["mathml table mXSS", '<math><mtext><table><mglyph><style><img title="--><img src=x onerror=alert(1)>">'],
    ["svg animate href", '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>'],
    ["declarative shadow root", '<template shadowrootmode="open"><script>alert(1)</script></template>'],
    ["iframe via broken markup", '<scr<script>ipt>alert(1)</scr</script>ipt>'],
  ])("%s leaves no executable surface", (_label, input) => {
    const host = render(input);
    expect(host.querySelector("script")).toBeNull();
    expect(eventHandlers(host)).toEqual([]);
    expect(openableHrefs(host)).toEqual([]);
    expect(dangerousAttrValues(host)).toEqual([]);
    // A real <script> element serialises as `<script`; shown source is `&lt;`.
    expect(host.innerHTML).not.toMatch(/<script/i);
  });
});

describe("the post-sanitise steps do not reopen the door", () => {
  test("a fence carries hostile-looking text as text, highlighted but inert", () => {
    const host = render('```html\n<img src="x" onerror="alert(1)">\n```');
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector("code")).not.toBeNull();
    // Still rendered — as text the reader can copy, not markup that ran.
    expect(host.textContent).toContain("onerror");
  });

  test("the autolink tail fix never invents an unopenable href", () => {
    const host = render("see https://example.com/x。然后继续 <a href=\"https://a.b\">y</a>");
    for (const a of host.querySelectorAll("a[href]")) {
      expect(isOpenableUrl(a.getAttribute("href"))).toBe(true);
    }
  });
});

describe("ordinary markdown still renders", () => {
  test("emphasis, links, and code survive the same pipeline", () => {
    const host = render("**bold** [ok](https://example.com) `x=1`");
    expect(host.querySelector("strong")?.textContent).toBe("bold");
    expect(host.querySelector('a[href="https://example.com"]')).not.toBeNull();
    expect(host.querySelector("code")?.textContent).toBe("x=1");
  });
});
