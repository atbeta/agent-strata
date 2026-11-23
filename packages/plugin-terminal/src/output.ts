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
 * is what turned a redraw, or a row the PTY had broken at the margin, into a
 * stack of short and blank lines. Hard wraps at `cols` are joined back: a
 * fragment that fills the width and does not end on a space is the middle of
 * a row, and one blank line after it is the extra row a full-width wrap leaves.
 * Runs of blank lines collapse to one. The result is still lines of text.
 */
export function terminalText(data: Uint8Array, cols?: number): string {
  const text = new TextDecoder().decode(data);
  const lines = foldLines(text);
  const joined = unwrapWidth(lines, cols).map((line) => line.replace(/[ \t]+$/, ""));
  const ended = text.endsWith("\n");
  const body = joined.join("\n") + (ended ? "\n" : "");
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
    if (code < 0x20 || code === 0x7f) continue;
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
  if (next !== "[") return Math.min(at + 1, text.length - 1);
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

/**
 * Put a row the terminal broke at the margin back together.
 *
 * A piece that fills `cols` and does not end on whitespace is not a finished
 * line — `ss` and `ps` get cut there, and the following blank row is the extra
 * line a full-width wrap leaves behind. A real line that happens to be exactly
 * `cols` wide and ends on a word can be joined too; that is rarer than the cut.
 */
function unwrapWidth(lines: string[], cols: number | undefined): string[] {
  if (cols === undefined || cols < 2) return lines;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    while (isWrap(line, cols) && i + 1 < lines.length) {
      let next = i + 1;
      if (lines[next] === "" && next + 1 < lines.length) next++;
      i = next;
      line += lines[i] ?? "";
    }
    out.push(line);
  }
  return out;
}

function isWrap(line: string, cols: number): boolean {
  return line.length > 0 && line.length % cols === 0 && /\S$/.test(line);
}
