import { marked } from "marked";

/**
 * A message as the top-level blocks it renders to, each as the source that
 * renders it on its own.
 *
 * The source is the block's identity: while a reply streams, every block but
 * the last comes back byte-identical, so its nodes and its cached HTML stay.
 * A block is parsed alone, which loses reference definitions written elsewhere
 * in the message — so when the message has any, every block carries them.
 */
export function splitBlocks(source: string): string[] {
  if (!source) return [];
  const tokens = marked.lexer(source);
  const defs = tokens
    .filter((t) => t.type === "def")
    .map((t) => t.raw.trim())
    .join("\n");
  const blocks: string[] = [];
  for (const t of tokens) {
    if (t.type === "space" || t.type === "def") continue;
    blocks.push(defs ? `${t.raw.trimEnd()}\n\n${defs}` : t.raw);
  }
  return blocks;
}
