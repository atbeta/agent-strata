/**
 * Where a streaming markdown message can be cut without lying.
 *
 * A reply arrives as a longer and longer string. Re-parsing all of it on each
 * frame is cheap; rebuilding the code blocks inside it is not. A fence that
 * has already closed cannot be changed by anything appended after it, so the
 * markup in front of the cut can stay on screen and only the tail is painted
 * again.
 *
 * The cut is only ever made at a fence whose marker starts at column 0.
 * CommonMark also allows a fence to be indented up to three spaces, and that
 * form is how a list item holds a code block. Cutting there would lift the
 * block out of the list. An indented fence stays in the tail, where it is
 * re-parsed together with the list it belongs to. A blank line is not a cut
 * either: a list item can continue after one.
 */

interface FenceOpen {
  char: "`" | "~";
  len: number;
}

function lineAt(source: string, index: number): { text: string; next: number } {
  let end = source.indexOf("\n", index);
  if (end === -1) end = source.length;
  let textEnd = end;
  if (textEnd > index && source[textEnd - 1] === "\r") textEnd -= 1;
  return {
    text: source.slice(index, textEnd),
    next: end < source.length ? end + 1 : source.length,
  };
}

/** A fence opener at column 0. A backtick fence cannot hide a backtick in its info string. */
function openingFence(line: string): FenceOpen | null {
  const char = line[0];
  if (char !== "`" && char !== "~") return null;
  let j = 1;
  while (j < line.length && line[j] === char) j += 1;
  const len = j;
  if (len < 3) return null;
  const info = line.slice(j);
  if (char === "`" && info.includes("`")) return null;
  return { char, len };
}

function closingFence(line: string, open: FenceOpen): boolean {
  let i = 0;
  while (i < line.length && line[i] === " " && i < 3) i += 1;
  if (line[i] !== open.char) return false;
  let j = i;
  while (j < line.length && line[j] === open.char) j += 1;
  if (j - i < open.len) return false;
  for (let k = j; k < line.length; k += 1) {
    const ch = line[k];
    if (ch !== " " && ch !== "\t") return false;
  }
  return true;
}

/**
 * Index where `source` splits into a finished prefix and a live tail.
 * The prefix is empty when nothing has closed yet. It ends just after the
 * last closed column-0 fence, or at an opener that is still missing its
 * closer — the prose before that opener is finished, the fence itself is not.
 */
export function stableBoundary(source: string): number {
  let i = 0;
  let last = 0;
  while (i < source.length) {
    const line = lineAt(source, i);
    const open = openingFence(line.text);
    if (!open) {
      if (line.next <= i) break;
      i = line.next;
      continue;
    }
    let j = line.next;
    let closedAt: number | null = null;
    while (j < source.length) {
      const inner = lineAt(source, j);
      if (closingFence(inner.text, open)) {
        closedAt = inner.next;
        break;
      }
      if (inner.next <= j) break;
      j = inner.next;
    }
    if (closedAt === null) return i;
    last = closedAt;
    i = closedAt;
  }
  return last;
}
