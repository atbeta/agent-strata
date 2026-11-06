import DOMPurify from "dompurify";

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
    const probe = document.createElement("template");
    probe.innerHTML = DOMPurify.sanitize(`<${name}></${name}>`);
    answer = probe.content.firstElementChild?.tagName.toLowerCase() === name;
    tagAnswers.set(name, answer);
  }
  return answer;
}

/**
 * Show a dropped tag that sits inside a sentence.
 *
 * A block that opens with one is source, and is handled before parsing — it
 * must not be reflowed (see `isSourceBlock`). This is the other shape: a
 * component named in prose. The tag becomes its own text, the sentence around
 * it is still markdown.
 */
export function revealDroppedTags(host: DocumentFragment) {
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
      if (!sanitizerKeepsTag(node.tagName.toLowerCase())) {
        node.replaceWith(document.createTextNode(node.outerHTML));
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

