/**
 * How a transcript hit becomes the two lines it shows.
 *
 * Kept out of the component so it can be tested: `bun test` compiles `.tsx`
 * with React's JSX runtime and Solid's transform never runs, so anything worth
 * asserting has to live here.
 */

import type { StrataEvent } from "./api";

/** Characters of context around the match, and before it when it is far in. */
const WINDOW = 160;
const LEAD = 40;

export interface PreviewWindow {
  lead: string;
  match: string;
  rest: string;
}

/**
 * The text a hit reads from — the whole message, not a prefix.
 *
 * These run to several thousand characters. It used to take the first 160,
 * which is why every result read like it had nothing to do with the query: the
 * word that matched was routinely sitting past that, at offset 800 or 1200.
 */
export function eventText(e: StrataEvent): string {
  const d = e.data;
  const blocks = (d.content ?? d.output) as unknown;
  if (Array.isArray(blocks))
    return blocks
      .map((b) =>
        typeof b === "object" && b !== null
          ? String((b as { text?: string }).text ?? `[${(b as { type?: string }).type}]`)
          : String(b),
      )
      .join(" ");
  if (typeof blocks === "string") return blocks;
  if (d.tool) return `${String(d.tool)} ${JSON.stringify(d.input ?? "").slice(0, 400)}`;
  if (d.title) return String(d.title);
  // Bounded on purpose: this is the shape we know least about, and it can carry
  // a whole provider payload.
  return JSON.stringify(d).slice(0, 4000);
}

/**
 * The slice of text a hit shows, with the match split out so it can be marked.
 *
 * A match near the top still reads from the top. One the query never reached —
 * OpenCode matches the stored event, and the field it matched is not always the
 * one this prints — falls back to the opening characters rather than to nothing.
 */
export function previewWindow(text: string, needle: string): PreviewWindow {
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) return { lead: text.slice(0, WINDOW), match: "", rest: "" };
  const from = at <= LEAD ? 0 : at - LEAD;
  return {
    lead: (from > 0 ? "…" : "") + text.slice(from, at),
    match: text.slice(at, at + needle.length),
    rest: text.slice(at + needle.length, from + WINDOW),
  };
}
