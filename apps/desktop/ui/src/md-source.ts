/**
 * The tag a block starts with, when the block opens with one.
 *
 * A message is cut into blocks before it is parsed, and a block that opens
 * with a tag is the one shape where the tag is the subject rather than
 * something embedded in a sentence. Only that case is worth asking about:
 * `use <x-card> here` is prose with a component named in it, while
 * `<x-card ...>…</x-card>` is the component's source.
 */
export function leadingTag(source: string): string | undefined {
  const match = /^\s*<([a-z][\w:.-]*)/i.exec(source);
  return match?.[1].toLowerCase();
}

/**
 * Whether a block is source rather than prose.
 *
 * `dropped` answers whether the renderer's sanitiser would delete that tag.
 * When the block opens with such a tag, rendering it as markdown would do two
 * things the reader did not ask for: hide the tag (the sanitiser keeps only
 * its children) and reflow the whitespace around it. Such a block is shown as
 * code, so every character the author wrote is still there to read.
 */
export function isSourceBlock(source: string, dropped: (tag: string) => boolean): boolean {
  const tag = leadingTag(source);
  return tag !== undefined && dropped(tag);
}
