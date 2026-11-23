import type { PtyReadPage } from "./types";

interface Chunk {
  start: number;
  data: Uint8Array;
}

export class OutputRing {
  private chunks: Chunk[] = [];
  private base = 0;
  private next = 0;

  constructor(private readonly capacity = 256 * 1024) {}

  push(data: Uint8Array): void {
    if (data.byteLength === 0) return;
    const copy = new Uint8Array(data);
    this.chunks.push({ start: this.next, data: copy });
    this.next += copy.byteLength;
    while (this.next - this.base > this.capacity && this.chunks.length > 0) {
      const excess = this.next - this.base - this.capacity;
      const first = this.chunks[0]!;
      if (first.data.byteLength <= excess) {
        this.base += first.data.byteLength;
        this.chunks.shift();
      } else {
        first.data = first.data.slice(excess);
        first.start += excess;
        this.base += excess;
      }
    }
  }

  replay(): Uint8Array {
    return this.read(this.base, this.capacity).data;
  }

  read(offset: number | undefined, maxBytes: number): PtyReadPage {
    const start = offset === undefined ? Math.max(this.base, this.next - maxBytes) : Math.max(offset, this.base);
    const dropped = offset !== undefined && offset < this.base;
    const from = Math.min(start, this.next);
    const parts: Uint8Array[] = [];
    let remaining = maxBytes;
    for (const chunk of this.chunks) {
      const end = chunk.start + chunk.data.byteLength;
      if (end <= from || remaining === 0) continue;
      const skip = Math.max(0, from - chunk.start);
      const part = chunk.data.slice(skip, skip + remaining);
      parts.push(part);
      remaining -= part.byteLength;
    }
    const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
    const data = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
      data.set(part, at);
      at += part.byteLength;
    }
    return { data, next_offset: from + length, dropped };
  }
}

/**
 * The text a reader would have left on each line, not every cursor motion.
 *
 * A bare carriage return rewrites the current line. Treating it as a newline
 * is what turned a redraw into a stack of short and blank lines. The rest of
 * the cursor vocabulary is honoured the same way: a backspace steps back, an
 * erase-in-line clears the part it names.
 *
 * A row the terminal broke at the margin is left broken. It used to be joined
 * back to the row after it, on the theory that a piece filling the width is
 * the middle of a row. That theory does not hold: `ps` truncates its own
 * output to the terminal width, so a finished row is exactly as wide as the
 * margin, and joining two finished rows loses the line between them.
 *
 * Runs of blank lines collapse to one. The result is still lines of text.
 */
export function terminalText(data: Uint8Array): string {
  const text = new TextDecoder().decode(data);
  const lines = foldLines(text).map((line) => line.replace(/[ \t]+$/, ""));
  const ended = text.endsWith("\n");
  const body = lines.join("\n") + (ended ? "\n" : "");
  return body.replace(/\n{3,}/g, "\n\n");
}

function foldLines(text: string): string[] {
  const lines: string[] = [];
  let line = "";
  let col = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\r" && text[i + 1] === "\n") {
      lines.push(line);
      line = "";
      col = 0;
      i++;
      continue;
    }
    if (ch === "\n") {
      lines.push(line);
      line = "";
      col = 0;
      continue;
    }
    if (ch === "\r") {
      col = 0;
      continue;
    }
    if (ch === "\b") {
      if (col > 0) col--;
      continue;
    }
    if (ch === "\u001b") {
      i = consumeEscape(text, i, () => {
        line = "";
        col = 0;
      }, (mode) => {
        if (mode === 0) line = line.slice(0, col);
        else if (mode === 1) line = line.slice(col);
        else line = "";
      });
      continue;
    }
    const code = ch.charCodeAt(0);
    // A tab is a separator, not a control code: `ps` and `ss` put one between
    // columns, and dropping it merges two fields into one word.
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) continue;
    line = col < line.length ? line.slice(0, col) + ch + line.slice(col + 1) : line + ch;
    col++;
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/** Skip a display sequence. `K` erases part of the current line; everything else is noise. */
function consumeEscape(
  text: string,
  at: number,
  clearLine: () => void,
  eraseInLine: (mode: number) => void,
): number {
  const next = text[at + 1];
  if (next === "]") {
    let i = at + 2;
    while (i < text.length) {
      if (text[i] === "\u0007") return i;
      if (text[i] === "\u001b" && text[i + 1] === "\\") return i + 1;
      i++;
    }
    return text.length - 1;
  }
  if (next !== "[") {
    // ESC, then any intermediates (0x20-0x2f) and one final byte (0x30-0x7e):
    // `ESC ( B` selects a character set and is three bytes long, so skipping
    // only the escape would leave its `B` in the text.
    let i = at + 1;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code >= 0x30 && code <= 0x7e) return i;
      if (code < 0x20 || code > 0x2f) return i - 1;
      i++;
    }
    return text.length - 1;
  }
  let i = at + 2;
  let params = "";
  while (i < text.length) {
    const ch = text[i]!;
    const code = ch.charCodeAt(0);
    if (code >= 0x40 && code <= 0x7e) {
      if (ch === "K") {
        const mode = Number(params.split(";")[0] || "0");
        if (mode === 2) clearLine();
        else eraseInLine(mode === 1 ? 1 : 0);
      }
      return i;
    }
    params += ch;
    i++;
  }
  return text.length - 1;
}
