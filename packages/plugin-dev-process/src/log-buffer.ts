import type { DevLogLine, DevLogPage } from "./types";

/** Bounded per-process output. A dev server that runs for hours must not grow without limit. */
export const MAX_LOG_LINES = 2000;

export class LogBuffer {
  private lines: DevLogLine[] = [];
  private nextSeq = 1;
  lastOutputAt: number | undefined;

  get all(): DevLogLine[] {
    return this.lines;
  }

  get hasOutput(): boolean {
    return this.lines.some((line) => !line.marker);
  }

  push(stream: "out" | "err", text: string, at: number, marker = false): DevLogLine {
    const line: DevLogLine = {
      seq: this.nextSeq,
      at,
      stream,
      text,
      ...(marker ? { marker: true } : {}),
    };
    this.nextSeq += 1;
    this.lines.push(line);
    if (this.lines.length > MAX_LOG_LINES) this.lines.splice(0, this.lines.length - MAX_LOG_LINES);
    // A marker is the service talking, not the command. Treating it as output
    // would make a restart look like the command had already spoken.
    if (!marker) this.lastOutputAt = at;
    return line;
  }

  read(query: { tail?: number; since?: number; offset?: number } = {}): DevLogPage {
    let lines = this.lines;
    let dropped = false;
    if (query.offset !== undefined) {
      const first = lines[0]?.seq;
      // The cursor points at a line the ring buffer has already forgotten.
      if (first !== undefined && query.offset + 1 < first) dropped = true;
      lines = lines.filter((line) => line.seq > query.offset!);
    } else if (query.since !== undefined) {
      const first = lines[0];
      if (first && first.seq > 1 && query.since < first.at) dropped = true;
      lines = lines.filter((line) => line.at > query.since!);
    }
    const hasCursor = query.offset !== undefined || query.since !== undefined;
    const tail = query.tail ?? (hasCursor ? lines.length : 200);
    if (tail > 0 && lines.length > tail) lines = lines.slice(-tail);
    const next = lines.at(-1)?.seq ?? this.lines.at(-1)?.seq ?? query.offset ?? 0;
    return { lines, next_offset: next, dropped };
  }
}
