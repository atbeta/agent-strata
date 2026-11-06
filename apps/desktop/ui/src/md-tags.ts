import DOMPurify from "dompurify";
import { sourceOf, isControlTag } from "./md-source";

/**
 * What a message may not carry.
 *
 * A transcript is content, not an application surface. DOMPurify keeps form
 * controls and embedded documents by default, so a reply containing
 * `<button>` or `<input>` drew a live control that looked like the app's own —
 * a fake button a reader could press, or a text field that swallowed a click.
 * Media is the same shape: an `<video autoplay>` starts playing on its own in
 * a column the reader is scrolling. These are shown as source instead (see
 * `revealDroppedTags`).
 */
export const SANITIZE_CONFIG: { FORBID_TAGS: string[]; FORBID_ATTR: string[] } = {
  FORBID_TAGS: [
    "button",
    "textarea",
    "select",
    "option",
    "optgroup",
    "form",
    "fieldset",
    "iframe",
    "object",
    "embed",
    "video",
    "audio",
    "source",
    "track",
  ],
  // A reply is content, not a stylesheet. A single `style="position:fixed;
  // inset:0;z-index:999"` covered the whole window; the app's own Tailwind
  // classes are global too, so `class` is stripped after the sanitise pass.
  FORBID_ATTR: ["style"],
};

/**
 * Whether the sanitiser keeps a tag.
 *
 * DOMPurify does not say what it removed. An unknown element is dropped and
 * its children are spliced into the parent, which is how a pasted Vue or
 * Angular component loses its opening and closing tag while the text between
 * them survives. The probe asks the sanitiser itself, so the answer cannot
 * drift from the pass that runs on every block. Tag names repeat, so each one
 * is asked once.
 */
const tagAnswers = new Map<string, boolean>();
export function sanitizerKeepsTag(name: string): boolean {
  let answer = tagAnswers.get(name);
  if (answer === undefined) {
    // `<thead>`, `<tr>` and `<td>` are only valid inside a table; asked on
    // their own, the parser discards them, and the probe would report a real
    // table part as one the sanitiser drops. Ask it where it is legal, so a
    // table reply is rendered as a table rather than shown as source.
    const inTable = TABLE_PARTS.has(name);
    const probe = document.createElement("template");
    probe.innerHTML = DOMPurify.sanitize(
      inTable ? tableProbe(name) : `<${name}></${name}>`,
      SANITIZE_CONFIG,
    );
    answer = inTable
      ? Boolean(probe.content.querySelector(`table ${name}`))
      : probe.content.firstElementChild?.tagName.toLowerCase() === name;
    tagAnswers.set(name, answer);
  }
  return answer;
}

/** Tags the HTML parser only keeps inside `<table>`. */
const TABLE_PARTS = new Set(["caption", "colgroup", "thead", "tbody", "tfoot", "tr", "td", "th"]);

/**
 * A table part in the smallest ancestors the parser requires.
 *
 * The parser does not just drop a part with no table: a `<tr>` gets an
 * implicit `<tbody>`, and a `<td>` needs a row. Probing them as bare children
 * of `<table>` reports valid parts as discarded, which is how a table reply
 * lost its rows and kept only empty sections.
 */
function tableProbe(name: string): string {
  if (name === "td" || name === "th") return `<table><tbody><tr><${name}></${name}></tr></tbody></table>`;
  if (name === "tr") return "<table><tbody><tr></tr></tbody></table>";
  return `<table><${name}></${name}></table>`;
}

/** The opening tag of an element's serialized markup, quotes respected. */
function openingTag(html: string): string {
  let quote = "";
  for (let i = 0; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return html.slice(0, i + 1);
    }
  }
  return html;
}

/**
 * A reply may describe a control; it may not draw one.
 *
 * GFM task lists are the exception: their checkbox is disabled and generated
 * by the parser. Anything else (`<input type="text">`, a live button) becomes
 * its own source, so a fake field cannot swallow a click.
 */
function shapeInputs(host: ParentNode) {
  for (const el of [...host.querySelectorAll("input")]) {
    const checkbox = el.getAttribute("type") === "checkbox" && el.hasAttribute("disabled");
    if (checkbox) continue;
    el.replaceWith(document.createTextNode(sourceOf(el.outerHTML)));
  }
}

/**
 * Strip every style hook a reply could have brought with it.
 *
 * `class` is kept only on a fenced block's `code`, where `language-*` is how
 * the highlighter knows what it is reading. Everything else loses its class
 * and its `data-*` attributes: the app's own utilities are global, so a reply
 * that says `class="fixed inset-0"` would cover the window, and `data-path`
 * would make its text look like a path the app itself linked.
 */
export function stripStyleHooks(host: ParentNode) {
  for (const el of host.querySelectorAll("[class], [data-path]")) {
    const lang = el.tagName === "CODE" ? el.getAttribute("class") : null;
    const keep = lang !== null && /(^|\s)language-/.test(lang);
    if (!keep) el.removeAttribute("class");
    for (const attr of [...el.attributes]) {
      if (attr.name.startsWith("data-")) el.removeAttribute(attr.name);
    }
  }
}

/**
 * Show a dropped tag that sits inside a sentence.
 *
 * A block that opens with one is source, and is handled before parsing — it
 * must not be reflowed (see `isSourceBlock`). This is the other shape: a
 * component named in prose. The tag becomes its own text, the sentence around
 * it is still markdown.
 */
export function revealDroppedTags(host: DocumentFragment, source = "") {
  shapeInputs(host);
  const dropped = new Set<string>();
  for (const el of host.querySelectorAll("*")) {
    const name = el.tagName.toLowerCase();
    if (!sanitizerKeepsTag(name)) dropped.add(name);
  }
  if (dropped.size === 0) return;

  // Outermost first: a component's own markup is source, so replacing it with
  // its `outerHTML` takes its children with it. A kept element can still hold
  // a dropped one, so the walk continues inside it.
  const walk = (parent: ParentNode) => {
    for (const node of [...parent.childNodes]) {
      if (!(node instanceof Element)) continue;
      const name = node.tagName.toLowerCase();
      if (!sanitizerKeepsTag(name)) {
        // An instruction wrapper is not source: its tag is scaffolding around
        // a sentence the reader needs, so drop the tag and keep the words.
        if (isControlTag(name)) {
          node.replaceWith(...node.childNodes);
          continue;
        }
        // A tag the author never closed is auto-closed by the parser, and its
        // outerHTML would invent a closing tag the message does not contain.
        // Put the opening tag back as text and leave the children where the
        // author wrote them; only a real closing tag is shown.
        if (source !== "" && !new RegExp(`</${name}\\s*>`, "i").test(source)) {
          node.replaceWith(document.createTextNode(sourceOf(openingTag(node.outerHTML))), ...node.childNodes);
          continue;
        }
        node.replaceWith(document.createTextNode(sourceOf(node.outerHTML)));
        continue;
      }
      walk(node);
    }
  };
  walk(host);
}

/** The source of a block, as code, on the lines it was written on. */
export function sourceBlock(source: string): HTMLElement {
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.className = "language-html";
  code.textContent = source.replace(/\s+$/, "");
  pre.append(code);
  return pre;
}

