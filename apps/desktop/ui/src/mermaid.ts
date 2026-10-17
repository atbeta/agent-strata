/**
 * Mermaid, in a transcript that does not need it.
 *
 * Mermaid is the heaviest thing this UI can pull in — around 0.6MB of shared
 * core, gzipped, plus roughly 100KB per diagram type on first use. Almost no
 * message in a transcript contains a diagram, so it is loaded on the first
 * block that needs it and never before. That keeps it out of the initial bundle
 * entirely: a session with no mermaid in it never pays for one.
 *
 * Three things about where this runs are worth stating, because each one is a
 * way this breaks if it is forgotten.
 *
 * The first is that a reply arrives as a longer string every token. A diagram
 * is not something to re-render on each of them, and mermaid's own parser would
 * be re-parsing a source that is still arriving. The transcript already draws
 * a line between what has finished and what is still being written — a fence
 * that has closed cannot be changed by anything appended after it — and only
 * the finished part is handed here. A block still streaming is left as code,
 * which is what it should look like anyway.
 *
 * The second is that the transcript is a windowed list. A row scrolls out of
 * the viewport and its DOM is dropped, then rebuilt when it comes back, so
 * anything rendered per mount runs again per visit. Rendering is therefore
 * keyed on the source: the same diagram already drawn in the same place is left
 * alone rather than torn down and rebuilt on every pass.
 *
 * The third is that this inserts SVG, which the markdown pipeline deliberately
 * never does — it sanitises first and then adds spans it created itself.
 * Mermaid's output is trusted to the extent that its own security level allows,
 * so that level is set here rather than left to a default that has changed
 * between versions, and the diagram is confined to the block it came from.
 */

/** Fence languages that mean "draw this" rather than "show this". */
const DIAGRAM_LANGUAGES = new Set(["mermaid"]);

/**
 * Is this fenced block a diagram?
 *
 * Kept as a predicate on the rendered DOM rather than on the source because
 * that is where the answer is already known: `marked` puts the language on the
 * `code` element and `stableBoundary` has already guaranteed the fence closed.
 */
export function isDiagramBlock(block: Element): block is HTMLElement {
  const code = block.firstElementChild;
  if (!(code instanceof HTMLElement) || code.tagName !== "CODE") return false;
  const lang = /\blanguage-([\w+#-]+)/.exec(code.className)?.[1];
  return lang !== undefined && DIAGRAM_LANGUAGES.has(lang.toLowerCase());
}

type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, source: string) => Promise<{ svg: string }>;
};

let loading: Promise<MermaidApi> | null = null;

/**
 * The engine, once, or the promise of it.
 *
 * Two diagrams on screen at the same time share this: the second waits on the
 * first rather than starting a second import of the same module, which the
 * bundler would deduplicate anyway but which would still parse twice if both
 * calls raced.
 */
function engine(): Promise<MermaidApi> {
  loading ??= import("mermaid")
    .then((mod) => {
      const api = (mod.default ?? mod) as unknown as MermaidApi;
      api.initialize({
        // The transcript is untrusted text: a message can be anything an agent
        // wrote, or anything a prompt asked for. `strict` keeps mermaid from
        // emitting raw HTML or script into the page, which is the difference
        // between rendering a diagram and executing one.
        securityLevel: "strict",
        startOnLoad: false,
        // A diagram that cannot be drawn is reported by the throw below, not by
        // a picture of an error pasted into the page. Left on, mermaid builds a
        // full illustrated error block and appends it to `document.body` — it
        // lands outside the transcript entirely, so the reader gets a stray
        // graphic at the foot of the window and the message that was supposed to
        // explain it says nothing at all.
        suppressErrorRendering: true,
        // A diagram is measured against the text it draws, and a runaway one can
        // ask for more than a window can hold. Refusing past a limit is a failed
        // render, which is already a state this knows how to report.
        maxTextSize: 50_000,
        // A transcript is a document, not a slideshow. No transition, and no
        // forced theme — the surrounding UI owns both.
        theme: "base",
        themeVariables: {
          // mermaid's base theme draws on white. A diagram pasted into a dark
          // transcript on white panels is a rectangle of glare, so the surface
          // and the ink are set to the app's own and the node fills follow.
          background: "transparent",
          primaryColor: "hsl(240 6% 18%)",
          primaryTextColor: "hsl(240 12% 88%)",
          primaryBorderColor: "hsl(240 6% 32%)",
          lineColor: "hsl(240 8% 55%)",
          secondaryColor: "hsl(240 6% 22%)",
          tertiaryColor: "hsl(240 6% 20%)",
          textColor: "hsl(240 12% 88%)",
          mainBkg: "hsl(240 6% 18%)",
          nodeBorder: "hsl(240 6% 32%)",
          clusterBkg: "hsl(240 6% 15%)",
          clusterBorder: "hsl(240 6% 30%)",
          edgeLabelBackground: "hsl(240 8% 12%)",
          actorBkg: "hsl(240 6% 18%)",
          actorBorder: "hsl(240 6% 32%)",
          actorTextColor: "hsl(240 12% 88%)",
          noteBkgColor: "hsl(45 40% 20%)",
          noteTextColor: "hsl(45 60% 88%)",
          noteBorderColor: "hsl(45 40% 40%)",
        },
        flowchart: { htmlLabels: false, useMaxWidth: true },
        // Diagrams are read, often printed, and often exported. A font that
        // does not exist falls back to something with a different baseline and
        // the diagram no longer lines up with its own labels.
        fontFamily: "inherit",
      });
      return api;
    })
    .catch((err) => {
      // A failed load must not be cached, or the retry is impossible for the
      // life of the window — the reader cannot recover from a block that never
      // gets another chance.
      loading = null;
      throw err;
    });
  return loading;
}

/**
 * Draw one block, in place, and say whether it worked.
 *
 * A diagram that cannot be drawn is left exactly as it was: the code block
 * stays, coloured and copyable as any other, and the reason goes underneath.
 * That is the whole fallback. Dropping the source would lose content the
 * reader can still use, and showing only mermaid's own error would answer a
 * question most readers did not ask.
 */
export async function drawDiagram(block: HTMLElement): Promise<{ ok: boolean; reason?: string }> {
  const code = block.firstElementChild;
  if (!(code instanceof HTMLElement)) return { ok: false };
  const source = code.textContent ?? "";
  if (!source.trim()) return { ok: false };

  // Already drawn, and the same diagram — and the drawing still present. The
  // flag alone is not enough: a holder that went away since (an unmounted row,
  // a rebuilt message) must get its render back rather than an early ok.
  if (
    block.dataset.diagram === source &&
    block.parentElement?.querySelector(":scope > .diagram-holder")?.hasChildNodes()
  ) {
    return { ok: true };
  }

  // A render in flight for this source: the answer is coming, and replacing it
  // with a second attempt is how two diagrams end up fighting over one block.
  if (block.dataset.diagramPending === source) return { ok: true };

  const id = `mmd-${Math.random().toString(36).slice(2, 10)}`;
  block.dataset.diagramPending = source;
  try {
    const api = await engine();
    const { svg } = await api.render(id, source);
    if (!svg) return { ok: false, reason: "empty" };

    // The host is a wrapper we own, so the SVG goes in there and never replaces
    // the code block. If the reader has scrolled on or the row was unmounted
    // while the engine was loading, there is nothing left to draw into and the
    // block keeps the source it already had.
    const holder = ensureHolder(block);
    if (!holder.isConnected) return { ok: false };
    holder.innerHTML = svg;
    block.dataset.diagram = source;
    block.hidden = true;
    return { ok: true };
  } catch (err) {
    sweepErrorArtifacts();
    return { ok: false, reason: reasonOf(err) };
  } finally {
    delete block.dataset.diagramPending;
  }
}

/**
 * Remove anything a failed draw left in the document.
 *
 * mermaid owns part of the page while it works — it needs a hidden container in
 * `document.body` to measure against — and on the failure paths it can leave
 * that container, and its error illustration, behind. They land outside the
 * message that was meant to explain them, so a reader sees a stray graphic at
 * the foot of the window with nothing connecting it to the block above. This is
 * cheap and unconditional: on success there is nothing to find, and on failure
 * leaving debris behind is worse than a walk over the document.
 */
function sweepErrorArtifacts(): void {
  // Scoped to mermaid's own ids. A broad class match would be a guess about
  // what else lives directly under `body`, and the app has no reason to put
  // its own content there.
  for (const node of [...document.querySelectorAll("body > [id^='d'], body > [id^='mmd-'], body > [id^='my-svg-']")]) {
    node.remove();
  }
}

/**
 * The element a diagram is drawn into, created once per block.
 *
 * Kept next to the code rather than replacing it so that a failure has
 * something to fall back to, and so the source stays in the DOM for copying
 * even while a diagram is showing.
 */
function ensureHolder(block: HTMLElement): HTMLElement {
  const existing = block.parentElement?.querySelector<HTMLElement>(":scope > .diagram-holder");
  if (existing) return existing;
  const holder = document.createElement("div");
  holder.className = "diagram-holder";
  block.insertAdjacentElement("afterend", holder);
  return holder;
}

/**
 * Turn a thrown diagram into something worth reading under the source.
 *
 * With `suppressErrorRendering` on there is no illustrated error block to read a
 * reason out of, so this has to survive whatever the failure actually carries —
 * an Error with a message, a bare string, a parser object with the details
 * somewhere on it, or nothing at all.
 */
function reasonOf(err: unknown): string {
  const parts: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) parts.push(v.trim());
  };
  push(err instanceof Error ? err.message : String(err));
  // mermaid's parser reports position and detail as separate fields rather than
  // folding them into the message, so the useful half is often only here.
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    push(e.str);
    const hash = e.hash as { message?: unknown } | undefined;
    push(hash?.message);
    if (parts.length === 0) {
      for (const [k, v] of Object.entries(e)) {
        if (typeof v === "string" && v.trim() && !/^(type|diagramType|message)$/.test(k)) {
          parts.push(v.trim());
        }
      }
    }
  }
  const raw = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!raw) return "unknown error";
  // mermaid's parse errors carry a caret pointing into the offending line and
  // then list every token it expected there. That list is the longest part of
  // the sentence and the least useful one: it recites the grammar at a reader
  // who asked for a flowchart. What says what to look at is the line number and
  // the text under the caret, so that is what is kept.
  const caret = raw.indexOf("^");
  const expect = /Expecting\s/i.exec(raw);
  // Everything from the caret onwards is mermaid listing what it could have
  // accepted — the whole grammar, recited at a reader who asked for a diagram.
  // What is left names the line and shows the text the caret is sitting in,
  // which is the part that says what to look at.
  let text = raw;
  if (expect && (caret < 0 || expect.index > caret)) {
    text = raw.slice(0, caret >= 0 ? caret : expect.index);
  }
  text = text
    .replace(/^Error:\s*/i, "")
    .replace(/[-—]+\s*$/, "")
    .replace(/[:：]\s*$/, "")
    .trim();
  if (!text) text = raw;
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
