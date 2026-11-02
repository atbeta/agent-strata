/**
 * How a re-parsed tail is patched into the nodes already on screen.
 *
 * A streaming reply is re-parsed on every token, but most of what comes back is
 * the string that was there a frame ago: a paragraph that grew by three
 * characters yields the same `<p>` holding a text node that is a little longer.
 * Replacing the block throws that node away — which blinks, collapses the
 * selection, reloads the images inside it and moves the scroll anchor — and for
 * a single growing paragraph it replaces the node on every single token, since
 * the block count never changes.
 *
 * So a block is patched in place: same tag, same attributes, and a text node
 * whose value is overwritten rather than swapped for a new one. What cannot be
 * patched is replaced, and everything after it is rebuilt, because a
 * difference early in the tree can change what the rest of it means.
 */

/** Whether two nodes have the same shape, and so can be patched into each other. */
export function canPatch(
  a: { nodeType: number; nodeName: string },
  b: { nodeType: number; nodeName: string },
): boolean {
  return a.nodeType === b.nodeType && a.nodeName === b.nodeName;
}

/**
 * `Node.ELEMENT_NODE`, spelled out.
 *
 * The constant is a static on the DOM interface, which does not exist in the
 * test runner — reading it there would throw before a single assertion could
 * run. The number is fixed by the DOM spec and will not change.
 */
const ELEMENT_NODE = 1;

/**
 * Bring `target` up to `source`, reusing the nodes it can.
 *
 * Returns true when the whole subtree was patched in place.
 */
function patchNode(target: Node, source: Node): boolean {
  if (!canPatch(target, source)) return false;

  // Text and comments have no children; their value is the whole node.
  if (target.nodeType !== ELEMENT_NODE) {
    if (target.nodeValue !== source.nodeValue) {
      (target as CharacterData).data = source.nodeValue ?? "";
    }
    return true;
  }

  const from = target as Element;
  const to = source as Element;

  // Attributes decide meaning for these blocks (`language-ts`, `href`, a
  // diagram's data attribute). A change there is a different node, not a
  // longer one, so it is rebuilt rather than patched around.
  const fromAttrs = from.attributes;
  const toAttrs = to.attributes;
  if (fromAttrs.length !== toAttrs.length) return false;
  for (let i = 0; i < toAttrs.length; i += 1) {
    const attr = toAttrs[i]!;
    if (from.getAttribute(attr.name) !== attr.value) return false;
  }

  patchChildren(from, to);
  return true;
}

/** Patch `from`'s children to match `to`'s, in order. */
function patchChildren(from: Node, to: Node): void {
  let i = 0;
  while (i < from.childNodes.length && i < to.childNodes.length) {
    const existing = from.childNodes[i]!;
    const wanted = to.childNodes[i]!;
    if (patchNode(existing, wanted)) {
      i += 1;
      continue;
    }
    // Nothing past the first real difference can be trusted to line up any
    // more, so drop the rest and rebuild it from the source.
    while (from.childNodes.length > i) from.removeChild(from.childNodes[i]!);
    break;
  }
  for (let j = i; j < to.childNodes.length; j += 1) from.appendChild(to.childNodes[j]!);
}

/**
 * Reconcile everything at or after `from` with `incoming`.
 *
 * Used for the tail of a message, which is re-parsed on every token while the
 * finished region before it is left alone.
 */
export function reconcileChildren(host: Node, from: number, incoming: readonly Node[]): void {
  let i = 0;
  while (i < incoming.length) {
    const at = from + i;
    const existing = host.childNodes[at];
    if (existing === undefined) break;
    if (!patchNode(existing, incoming[i]!)) break;
    i += 1;
  }
  // The first block that could not be patched takes the rest of the tail with
  // it: a structural change here reflows what follows.
  while (host.childNodes.length > from + i) host.removeChild(host.childNodes[from + i]!);
  for (let j = i; j < incoming.length; j += 1) host.appendChild(incoming[j]!);
}
