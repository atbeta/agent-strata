import { createEffect, onCleanup } from "solid-js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { stripAnsi } from "./ansi";
import { grammarFor, guessGrammar, tokenize, tokenizeDiff } from "./highlight";
import { stableBoundary } from "./md-stream";

marked.setOptions({ gfm: true, breaks: true });

export function Md(props: { text: string; class?: string }) {
  let host: HTMLDivElement | undefined;
  let frame = 0;
  let started = false;
  /** Source slice already sitting in `host` as finished blocks. */
  let renderedStable = "";
  /** How many of `host`'s child nodes belong to that slice. The rest is the tail. */
  let stableCount = 0;

  const paint = (source: string) => {
    if (!host) return;
    const cut = stableBoundary(source);
    const stable = source.slice(0, cut);
    const tail = source.slice(cut);

    // A rewrite of earlier text, rather than a longer reply, cannot reuse the
    // nodes. Streaming only ever appends, so this is the other path: an edit,
    // a replaced message, a row the list handed a different turn.
    if (!stable.startsWith(renderedStable)) {
      host.replaceChildren();
      renderedStable = "";
      stableCount = 0;
    }

    if (stable.length > renderedStable.length) {
      // The new finished region includes the previous tail. Drop that tail
      // before appending, or the closed fence would sit after its own leftover.
      dropTail(host, stableCount);
      const frag = nodesFrom(stable.slice(renderedStable.length));
      const count = frag.childNodes.length;
      host.append(frag);
      stableCount += count;
      renderedStable = stable;
    }

    dropTail(host, stableCount);
    if (tail.length > 0) host.append(nodesFrom(tail));
  };

  /**
   * A message being written hands this a new text on every token. The first
   * one renders at once — every message in a transcript runs this effect at
   * least once, and deferring them all would flash an empty line. Later text
   * waits for the frame, so a burst costs one paint rather than one each, and
   * the frame reads whatever is current rather than what was queued.
   *
   * That paint does not rebuild the blocks already closed. A fence that has
   * finished stays where it is, colours and all; only the tail, the part a
   * further token can still change, is parsed and coloured again.
   */
  createEffect(() => {
    const source = props.text;
    if (!host) return;
    if (!started) {
      started = true;
      paint(source);
      return;
    }
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint(props.text);
    });
  });

  onCleanup(() => {
    if (frame) cancelAnimationFrame(frame);
  });

  return <div ref={host} class={`md ${props.class ?? ""}`} />;
}

function dropTail(host: HTMLElement, stableCount: number) {
  while (host.childNodes.length > stableCount) host.lastChild!.remove();
}

function nodesFrom(markdown: string): DocumentFragment {
  const tpl = document.createElement("template");
  tpl.innerHTML = DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string);
  highlightCode(tpl.content);
  return tpl.content;
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
