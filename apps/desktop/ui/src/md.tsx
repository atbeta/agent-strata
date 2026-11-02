import { createEffect, createMemo, createSignal, For, onCleanup } from "solid-js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { stripAnsi } from "./ansi";
import { grammarFor, guessGrammar, tokenize, tokenizeDiff } from "./highlight";
import { splitBlocks } from "./md-blocks";
import { reconcileList } from "./md-reconcile";
import { stableKeys } from "./keyed";
import { drawDiagram, isDiagramBlock } from "./mermaid";
import { t } from "./i18n";
import { MarkdownHtmlCache } from "./md-cache";
import { openImage } from "./image-viewer";
import { enqueuePaint, firstPaint, type PaintCancel } from "./paint-queue";
import { useRowPaintHold, useRowPaintMode } from "./paint-mode";

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
  let started = false;
  const mode = useRowPaintMode();
  const paintHold = useRowPaintHold();
  let cancelIdle: PaintCancel | undefined;
  let releaseHold: (() => void) | undefined;
  const release = () => {
    releaseHold?.();
    releaseHold = undefined;
  };
  /**
   * The text on screen and whether it was still being written. A frame that
   * resolves to the same pair is not a change: the view refreshes faster than
   * a reply grows, and nothing downstream should wake for it. `live` is part of
   * it — the flip from streaming to finished is what draws a diagram.
   */
  const [shown, setShown] = createSignal<Painted | undefined>(undefined, { equals: samePaint });
  const current = (): Painted => ({ text: props.text, live: props.live === true });

  /**
   * A message being written hands this a new text on every token. The first
   * one renders at once — every message in a transcript runs this effect at
   * least once, and deferring them all would flash an empty line. Later text
   * waits for the frame, so a burst costs one paint rather than one each, and
   * the frame reads whatever is current rather than what was queued.
   */
  createEffect(() => {
    const live = props.live === true;
    void props.text;
    if (!started) {
      // Off-screen rows wait. Parsing every one of them in the scroll turn is
      // the hitch. A row that was already queued and then scrolls into view
      // stays on the queue and goes first on the next frame — painting it
      // here would be that parse, on this turn. A row that mounts already on
      // screen, and a reply that is still being written, do not wait.
      const go = () => {
        if (started) return;
        started = true;
        setShown(current());
      };
      const plan = firstPaint({ live, visible: mode() === "now", queued: cancelIdle !== undefined });
      if (plan === "now") {
        cancelIdle?.();
        cancelIdle = undefined;
        release();
        go();
      } else if (plan === "soon") {
        cancelIdle?.prioritize();
      } else if (!cancelIdle) {
        releaseHold ??= paintHold.hold();
        cancelIdle = enqueuePaint(() => {
          release();
          go();
        });
      }
      return;
    }
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      setShown(current());
    });
  });

  const live = () => shown()?.live === true;
  const blocks = createMemo(() => splitBlocks(shown()?.text ?? ""));
  /** Every block but the one still being written. Each renders once, by its source. */
  const settled = createMemo<readonly string[]>((prev) =>
    stableKeys(prev, live() ? blocks().slice(0, -1) : blocks()),
  );
  /**
   * The block a reply is still writing, patched into the nodes it had a frame
   * ago — a paragraph that grew keeps its node and its text node, so nothing
   * blinks, a selection holds and an image does not reload.
   */
  const tail = createMemo<Node[]>((prev) => {
    const last = live() ? blocks().at(-1) : undefined;
    if (last === undefined) return [];
    return reconcileList(prev, withCaret(blockNodes(last, false)));
  }, []);

  onCleanup(() => {
    if (frame) cancelAnimationFrame(frame);
    cancelIdle?.();
    cancelIdle = undefined;
    release();
  });

  return (
    <div
      class={`md ${props.class ?? ""}`}
      onClick={(e) => {
        const img = e.target instanceof HTMLImageElement ? e.target : undefined;
        // A linked image navigates; it is a link first and a picture second.
        if (!img || img.closest("a")) return;
        openImage(img.currentSrc || img.src, img.alt);
      }}
    >
      {/* Straight into `.md`, no wrapper: the theme styles `.md > :first-child`. */}
      <For each={settled()}>{(source) => blockNodes(source, true)}</For>
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
 * Parse one block of markdown into nodes.
 *
 * `finished` says whether no further token can change this block. It decides
 * two things. A finished block replays its sanitised, highlighted HTML from the
 * cache; the block a reply is still writing is new on every token, so caching
 * it would only evict what is worth keeping. And a finished block draws its
 * diagram: a fence that is still arriving is not a diagram yet, it is half of
 * one, and drawing it would mean drawing it again on the next frame.
 */
function nodesFrom(markdown: string, finished: boolean): DocumentFragment {
  const tpl = document.createElement("template");
  const cached = finished ? htmlCache.get(markdown) : undefined;
  if (cached === undefined) {
    tpl.innerHTML = DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string);
    highlightCode(tpl.content);
    if (finished) htmlCache.set(markdown, tpl.innerHTML);
  } else {
    tpl.innerHTML = cached;
  }
  if (finished) drawDiagrams(tpl.content);
  return tpl.content;
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

    const tokens =
      tokenizeDiff(src) ?? tokenize(src, grammarFor(lang) ?? guessGrammar(src));

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
    const label = lang ?? guessGrammar(src);
    if (label) block.dataset.lang = label;
  }
}
