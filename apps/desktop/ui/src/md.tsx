import { createEffect, createMemo, createSignal, For, on, onCleanup, untrack } from "solid-js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { stripAnsi } from "./ansi";
import { grammarFor, guessGrammar, tokenize, tokenizeDiff } from "./highlight";
import { splitBlocks } from "./md-blocks";
import { isSourceBlock, tableWrapped } from "./md-source";
import {
  revealDroppedTags,
  sanitizerKeepsTag,
  sourceBlock,
  stripStyleHooks,
  SANITIZE_CONFIG,
} from "./md-tags";
import { reconcileList } from "./md-reconcile";
import { stableKeys } from "./keyed";
import { splitLinkTail } from "./link-tail";
import { drawDiagram, isDiagramBlock } from "./mermaid";
import { copyText } from "./clipboard";
import { locale, t } from "./i18n";
import { MarkdownHtmlCache } from "./md-cache";
import { openImage } from "./image-viewer";
import { markPathCandidates, pathActions, queueConfirm } from "./path-link";
marked.setOptions({ gfm: true, breaks: true });

const htmlCache = new MarkdownHtmlCache();

type Painted = { text: string; live: boolean };

const samePaint = (a: Painted | undefined, b: Painted | undefined) =>
  a?.text === b?.text && a?.live === b?.live;

/**
 * Markdown as blocks: every block but the one a reply is still writing is
 * rendered once, by its source, and kept; only that last block is parsed again
 * on each token. A reply of prose used to be parsed whole on every frame,
 * because the only place it could be cut was a closed code fence.
 */
export function Md(props: { text: string; class?: string; live?: boolean }) {
  let frame = 0;
  const current = (): Painted => ({ text: props.text, live: props.live === true });
  /**
   * The text on screen and whether it was still being written. A frame that
   * resolves to the same pair is not a change: the view refreshes faster than
   * a reply grows, and nothing downstream should wake for it. `live` is part of
   * it — the flip from streaming to finished is what draws a diagram.
   *
   * The first text renders with the row: the list mounts a row off screen
   * only once its markdown is in the cache, so this is a replay there and a
   * parse only for what is on screen.
   */
  const [shown, setShown] = createSignal<Painted>(untrack(current), { equals: samePaint });

  /**
   * A message being written hands this a new text on every token. Later text
   * waits for the frame, so a burst costs one paint rather than one each, and
   * the frame reads whatever is current rather than what was queued.
   */
  createEffect(
    on(
      () => [props.text, props.live],
      () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          setShown(current());
        });
      },
      { defer: true },
    ),
  );

  const live = () => shown().live;
  const blocks = createMemo(() => splitBlocks(shown().text));
  /** Every block but the one still being written. Each renders once, by its source. */
  const settled = createMemo<readonly string[]>((prev) =>
    stableKeys(prev, live() ? blocks().slice(0, -1) : blocks()),
  );
  /**
   * The block a reply is still writing, patched into the nodes it had a frame
   * ago — a paragraph that grew keeps its node and its text node, so nothing
   * blinks, a selection holds and an image does not reload.
   */
  /**
   * Path linkification is a per-instance pass, not part of `parsed()`: the
   * cached HTML stays shared, and a view with no PathActions context — the
   * trace drawer — keeps its paths as plain text instead of dead links.
   *
   * Only a finished block is asked about. A block still being written is
   * parsed again on every token, and asking the service about a path that
   * may still change would be asking twice for the same answer. When the
   * block settles it is parsed and marked like any other, and the paths
   * appear then.
   */
  const paths = pathActions();
  const paint = (source: string, finished: boolean): Node[] => {
    const nodes = blockNodes(source, finished);
    if (!paths) return nodes;
    const frag = document.createDocumentFragment();
    frag.append(...nodes);
    if (!finished) return [...frag.childNodes];
    const candidates = markPathCandidates(frag);
    if (candidates.length) queueConfirm(paths, candidates);
    return [...frag.childNodes];
  };

  const tail = createMemo<Node[]>((prev) => {
    const last = live() ? blocks().at(-1) : undefined;
    if (last === undefined) return [];
    return reconcileList(prev, withCaret(paint(last, false)));
  }, []);

  onCleanup(() => {
    if (frame) cancelAnimationFrame(frame);
  });

  /** The root, for the one sweep a language switch needs. */
  let root: HTMLDivElement | undefined;
  /**
   * Code chips are the only chrome this component draws, and a message is not
   * re-rendered when the language changes: `t()` is read while the nodes are
   * built, not from the JSX. So the labels are refreshed in place. Without
   * this, a transcript painted in Chinese keeps saying 复制 after a switch to
   * English — a half-translated screen in the one pair of strings this file
   * owns.
   */
  createEffect(
    on(
      locale,
      () => {
        for (const chip of root?.querySelectorAll<HTMLElement>("[data-code-copy]") ?? []) {
          paintCopyChip(chip, chip.hasAttribute("data-copied"));
        }
      },
      { defer: true },
    ),
  );

  return (
    <div
      ref={(el) => (root = el)}
      class={`md ${props.class ?? ""}`}
      onClick={(e) => {
        const target = e.target instanceof Element ? e.target : undefined;
        // The code chip is decoration over injected HTML — there is no
        // component behind it to receive a click — so the message root routes
        // it, the same way it routes a path link.
        const chip = target?.closest<HTMLElement>("[data-code-copy]");
        if (chip) {
          e.preventDefault();
          copyCode(chip);
          return;
        }
        const pathEl = target?.closest("[data-path]");
        if (pathEl instanceof HTMLElement && pathEl.dataset.path) {
          e.preventDefault();
          // The anchor travels with the click: a failure is shown where the
          // reader clicked, not at the bottom of a column they may have
          // scrolled away from.
          paths?.open(pathEl.dataset.path, pathEl);
          return;
        }
        const img = target instanceof HTMLImageElement ? target : undefined;
        // A linked image navigates; it is a link first and a picture second.
        if (!img || img.closest("a")) return;
        openImage(img.currentSrc || img.src, img.alt);
      }}
    >
      {/* Straight into `.md`, no wrapper: the theme styles `.md > :first-child`. */}
      <For each={settled()}>{(source) => paint(source, true)}</For>
      {tail()}
    </div>
  );
}

function blockNodes(source: string, finished: boolean): Node[] {
  return [...nodesFrom(source, finished).childNodes];
}

/** The streaming caret, at the end of the text the last block ends with. */
function withCaret(nodes: Node[]): Node[] {
  const last = nodes.findLast((n): n is Element => n.nodeType === 1);
  const target = last ? cursorTarget(last) : undefined;
  if (!target) return nodes;
  const caret = document.createElement("span");
  caret.className = "streaming-caret ml-0.5 inline-block h-[1em] w-[2px] translate-y-0.5 motion-safe:animate-pulse bg-foreground/70 align-text-bottom";
  caret.setAttribute("aria-hidden", "true");
  target.append(caret);
  return nodes;
}

function cursorTarget(block: Element): Element | undefined {
  if (/^(P|H[1-6])$/.test(block.tagName)) return block;
  if (block.tagName === "BLOCKQUOTE") {
    const last = block.lastElementChild;
    return last ? cursorTarget(last) : block;
  }
  if (!/^(UL|OL)$/.test(block.tagName)) return undefined;
  const item = block.lastElementChild;
  if (!item) return undefined;
  const last = item.lastElementChild;
  if (!last) return item;
  if (last.tagName === "PRE") return undefined;
  return /^(P|UL|OL)$/.test(last.tagName) ? cursorTarget(last) : item;
}

/**
 * Sanitised, highlighted nodes for one block. A finished block replays its HTML
 * from the cache; the block a reply is still writing is new on every token, so
 * caching it would only evict what is worth keeping.
 */
export function parsed(markdown: string, finished: boolean): DocumentFragment {
  const tpl = document.createElement("template");
  const cached = finished ? htmlCache.get(markdown) : undefined;
  if (cached === undefined) {
    if (isSourceBlock(markdown, (tag) => !sanitizerKeepsTag(tag))) {
      tpl.content.append(sourceBlock(markdown));
    } else {
      tpl.innerHTML = marked.parse(tableWrapped(markdown), { async: false }) as string;
      revealDroppedTags(tpl.content, markdown);
      tpl.innerHTML = DOMPurify.sanitize(tpl.innerHTML, SANITIZE_CONFIG);
      stripStyleHooks(tpl.content);
      fixAutolinkTails(tpl.content);
    }
    highlightCode(tpl.content);
    if (finished) htmlCache.set(markdown, tpl.innerHTML);
  } else {
    tpl.innerHTML = cached;
  }
  return tpl.content;
}

/**
 * Give back the sentence a Chinese autolink swallowed.
 *
 * The parser's autolink pattern ends at whitespace, so a full stop or a
 * parenthetical written straight after an address is taken as part of it:
 * `http://localhost:3000/。` becomes one link, and following it goes to an
 * address that cannot exist. ASCII punctuation is handled by the parser; only
 * CJK is not, which is why this reads as a Chinese-only bug.
 *
 * Two conditions keep this from touching links a person wrote. The visible text
 * has to be the address itself — a `[官方文档](url)` link says something else, and
 * its text is none of this module's business — and the address has to be one
 * whose trailing punctuation the splitter actually recognises. Everything else
 * is left exactly as parsed.
 */
function fixAutolinkTails(host: ParentNode) {
  for (const link of host.querySelectorAll("a[href]")) {
    const text = link.textContent ?? "";
    // Only a link that shows its own address is an autolink. A link with
    // markup inside is a hand-written one, and its text is the author's.
    if (link.childNodes.length !== 1 || link.firstChild?.nodeType !== Node.TEXT_NODE) continue;
    let decoded: string;
    try {
      decoded = decodeURIComponent(link.getAttribute("href") ?? "");
    } catch {
      // A malformed escape is not something to guess about.
      continue;
    }
    if (decoded !== text) continue;
    const { keep, tail } = splitLinkTail(text);
    if (tail === "") continue;
    link.setAttribute("href", encodeURI(keep));
    link.textContent = keep;
    // The sentence continues right where the address stopped.
    link.after(document.createTextNode(tail));
  }
}

/**
 * Parse one block of markdown into nodes.
 *
 * `finished` says whether no further token can change this block. It decides
 * two things: whether the block goes through the cache, and whether it draws
 * its diagram — a fence that is still arriving is not a diagram yet, it is
 * half of one, and drawing it would mean drawing it again on the next frame.
 */
function nodesFrom(markdown: string, finished: boolean): DocumentFragment {
  const content = parsed(markdown, finished);
  decorateCodeBlocks(content);
  if (finished) drawDiagrams(content);
  return content;
}

/**
 * Parse a message into the cache ahead of its row, so the row that mounts
 * later replays HTML instead of parsing it. Nothing is drawn: a diagram is
 * drawn by the block that mounts.
 */
export function warmMarkdown(text: string): void {
  for (const block of splitBlocks(text)) {
    if (htmlCache.get(block) === undefined) parsed(block, true);
  }
}

/**
 * Draw every diagram in a finished block.
 *
 * Each diagram block is wrapped before the nodes go in: the list rendering the
 * message holds the top-level nodes a block produced and nothing else. A holder
 * the draw inserted as a bare sibling of the block would be a node the list
 * never held — left behind when the block goes, or dropped while its source
 * stays hidden. The wrapper makes block, holder, and failure note one node.
 *
 * The blocks are walked here, while the nodes are still in a fragment, and each
 * one is drawn once it is connected — a diagram engine measures its output
 * against the document, and a detached subtree measures against nothing, which
 * is how a diagram ends up sized to zero.
 */
function drawDiagrams(host: ParentNode) {
  const blocks = [...host.querySelectorAll("pre")].filter(isDiagramBlock);
  if (!blocks.length) return;
  for (const block of blocks) {
    const wrap = document.createElement("div");
    wrap.className = "diagram-block";
    block.replaceWith(wrap);
    wrap.append(block);
  }
  // `queueMicrotask` waits for the fragment to have been appended without
  // making the caller await a render.
  queueMicrotask(() => {
    for (const block of blocks) {
      if (!block.isConnected) continue;
      void drawDiagram(block).then((r) => {
        if (r.ok || !r.reason) return;
        noteDiagramFailure(block, r.reason);
      });
    }
  });
}

/**
 * Say why a diagram is not on screen, under the source that replaced it.
 *
 * The note is the difference between a reader knowing the diagram was rejected
 * and a reader wondering whether the model drew one at all.
 */
function noteDiagramFailure(block: Element, reason: string) {
  const parent = block.parentElement;
  if (!parent) return;
  let note = parent.querySelector<HTMLElement>(":scope > .diagram-note");
  if (!note) {
    note = document.createElement("p");
    note.className = "diagram-note";
    note.setAttribute("role", "note");
    block.insertAdjacentElement("afterend", note);
  }
  note.textContent = `${t("diagram.failed")} ${reason}`;
}

/**
 * Colour the fenced code blocks marked produced.
 *
 * This runs on the rendered DOM rather than in the markdown pipeline: the HTML
 * is sanitised first, and adding spans afterwards means the highlighter never
 * has to be trusted by the sanitiser's allow-list. The spans we insert are ones
 * we just created from a plain-text source, so there is nothing to sanitise.
 *
 * `host` is a fragment when the nodes have not been inserted yet, so a closed
 * fence that already lives in the message is not walked again.
 */
function highlightCode(host: ParentNode) {
  for (const block of host.querySelectorAll("pre")) {
    const code = block.firstElementChild;
    if (!(code instanceof HTMLElement) || code.tagName !== "CODE") continue;

    const lang = /\blanguage-([\w+#-]+)/.exec(code.className)?.[1];
    const src = stripAnsi(code.textContent ?? "");
    if (!src) continue;

    // One guess, used for both the colours and the label: the label is what the
    // reader sees, so it must not disagree with what was coloured.
    const guessed = lang ? null : guessGrammar(src);
    const tokens = tokenizeDiff(src) ?? tokenize(src, grammarFor(lang) ?? guessed);

    code.replaceChildren(
      ...tokens.map((t) => {
        if (t.kind === "plain") return document.createTextNode(t.text);
        const span = document.createElement("span");
        span.className = `tok-${t.kind}`;
        span.textContent = t.text;
        return span;
      }),
    );

    // The label is drawn from CSS so the frame does not need extra markup.
    const label = lang ?? guessed;
    if (label) block.dataset.lang = label;
  }
}

/** How long the chip says 已复制. The tool wells settled on the same beat. */
const COPIED_MS = 1200;

/** A reset per chip, so a second click restarts the confirmation rather than
 *  letting the first one's timer clear it early. */
const copiedTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/**
 * Make every fenced block takeable: one chip, at the far end of the block's
 * own header strip, shown when the pointer or the keyboard arrives.
 *
 * It hangs on a wrapper rather than on the `pre` itself. The `pre` is the
 * horizontal scroller, so a control inside it would ride out of the corner
 * with the first long line; the tool wells keep theirs on a relative frame for
 * exactly that reason.
 *
 * Every code block gets that strip, including the one whose language the
 * highlighter could not name: the label is drawn by `pre[data-lang]::before`,
 * so an empty `data-lang` is what gives an anonymous fence the same header the
 * labelled ones have. Without it the chip would sit over the first line of
 * code, and a long first line would be covered by the button meant to copy it.
 *
 * This runs on the nodes a paint produced, never inside `parsed()`. The HTML
 * cache would otherwise freeze the label into it: the chip's text is chrome,
 * so a cached one would still say 复制 after the language switched, and a
 * replayed button would carry a copy state that belongs to no click.
 *
 * A diagram fence is left alone. Its `pre` is hidden and replaced by the
 * drawing, and a copy affordance floating over a picture is not a copy of
 * anything the reader can see.
 */
function decorateCodeBlocks(host: ParentNode) {
  for (const node of host.querySelectorAll("pre")) {
    // Untyped on purpose: `isDiagramBlock` asserts `HTMLElement`, and narrowing
    // an already-`HTMLPreElement` argument would collapse the rest of the loop
    // to `never`.
    const pre: Element = node;
    if (isDiagramBlock(pre)) continue;
    // Only a fence, or a source block: a bare `<pre>` written by hand has no
    // code element, and the strip's geometry assumes one.
    const code = pre.firstElementChild;
    if (!(code instanceof HTMLElement) || code.tagName !== "CODE") continue;
    // An empty fence has nothing to take away.
    if ((code.textContent ?? "").trim() === "") continue;
    if (!pre.hasAttribute("data-lang")) pre.setAttribute("data-lang", "");
    const block = document.createElement("div");
    block.className = "code-block";
    pre.replaceWith(block);
    block.append(pre, copyChip());
  }
}

function copyChip(): HTMLButtonElement {
  const chip = document.createElement("button");
  chip.type = "button";
  // Built as a DOM node because a message arrives as HTML: a Solid `Button`
  // cannot mount inside the nodes this pass produces.
  chip.className = "code-copy";
  chip.dataset.codeCopy = "";
  paintCopyChip(chip, false);
  return chip;
}

/** The chip's two states, as one place that knows both of them. */
function paintCopyChip(chip: HTMLElement, copied: boolean) {
  const label = copied ? t("code.copied") : t("code.copy");
  const text = document.createElement("span");
  text.textContent = label;
  chip.replaceChildren(chipGlyph(copied ? "check" : "copy"), text);
  chip.setAttribute("aria-label", label);
  if (copied) chip.dataset.copied = "";
  else delete chip.dataset.copied;
}

/**
 * The same two glyphs as `icons.tsx` ("copy" and "check"), drawn here because
 * this block lives inside injected HTML, where `<Icon>` cannot mount.
 */
function chipGlyph(name: "copy" | "check"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [attr, value] of Object.entries({
    viewBox: "0 0 16 16",
    class: "size-3",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.5",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(attr, value);
  }
  const shape = (tag: string, attrs: Record<string, string>) => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [attr, value] of Object.entries(attrs)) el.setAttribute(attr, value);
    svg.append(el);
  };
  if (name === "check") shape("path", { d: "M3.4 8.3 6.5 11.4 12.6 4.8" });
  else {
    shape("rect", { x: "6", y: "6", width: "6.6", height: "6.6", rx: "1.2" });
    shape("path", { d: "M4.2 10.2V4.2c0-.6.5-1.1 1.1-1.1H10" });
  }
  return svg;
}

/**
 * Copy what the block shows.
 *
 * The source is the `code` node's text, not the block's: the chip lives
 * outside the `pre`, so its own label can never leak into the clipboard, and
 * the highlighter has already replaced the escapes with plain text.
 */
function copyCode(chip: HTMLElement) {
  const pre = chip.closest(".code-block")?.querySelector("pre");
  if (!pre) return;
  const source = (pre.querySelector("code") ?? pre).textContent ?? "";
  void copyText(source).then((ok) => {
    if (!ok || !chip.isConnected) return;
    paintCopyChip(chip, true);
    clearTimeout(copiedTimers.get(chip));
    copiedTimers.set(
      chip,
      setTimeout(() => {
        copiedTimers.delete(chip);
        if (chip.isConnected) paintCopyChip(chip, false);
      }, COPIED_MS),
    );
  });
}
