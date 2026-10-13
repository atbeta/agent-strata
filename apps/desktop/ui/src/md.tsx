import { createEffect, onCleanup } from "solid-js";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { stripAnsi } from "./ansi";
import { grammarFor, guessGrammar, tokenize, tokenizeDiff } from "./highlight";

marked.setOptions({ gfm: true, breaks: true });

export function Md(props: { text: string; class?: string }) {
  let host: HTMLDivElement | undefined;
  let frame = 0;
  let started = false;

  const render = (source: string) => {
    if (!host) return;
    host.innerHTML = DOMPurify.sanitize(
      marked.parse(source, { async: false }) as string,
    );
    highlightCode(host);
  };

  /**
   * A message being written hands this a new text on every token, and each one
   * re-parsed the whole message, re-sanitised it and replaced the markup — tens
   * of milliseconds, as many times a second as the model produced words, for a
   * change too small for anyone to see yet. Later text waits for the frame
   * instead, so a burst of tokens costs one parse rather than one each, and the
   * frame reads whatever is current rather than what was queued.
   *
   * The first one still renders at once. Every message in a transcript runs
   * this effect at least once, so deferring them all would trade a cost nobody
   * could see for an empty line everybody would.
   */
  createEffect(() => {
    const source = props.text;
    if (!host) return;
    if (!started) {
      started = true;
      render(source);
      return;
    }
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      render(props.text);
    });
  });

  onCleanup(() => {
    if (frame) cancelAnimationFrame(frame);
  });

  return <div ref={host} class={`md ${props.class ?? ""}`} />;
}

/**
 * Colour the fenced code blocks marked produced.
 *
 * This runs on the rendered DOM rather than in the markdown pipeline: the HTML
 * is sanitised first, and adding spans afterwards means the highlighter never
 * has to be trusted by the sanitiser's allow-list. The spans we insert are ones
 * we just created from a plain-text source, so there is nothing to sanitise.
 */
function highlightCode(host: HTMLElement) {
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