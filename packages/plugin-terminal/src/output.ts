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

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

export function terminalText(data: Uint8Array): string {
  return new TextDecoder()
    .decode(data)
    .replace(ANSI, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}
