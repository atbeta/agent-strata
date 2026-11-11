/**
 * Text decoders, tried in order.
 *
 * `cmd.exe` on a Chinese Windows writes GBK (code page 936), and decoding that
 * as UTF-8 turns every message into `�����ɹ�`. UTF-8 is tried first because it is
 * the common case and `fatal: true` makes it reject anything that is not UTF-8
 * instead of silently producing replacement characters.
 */
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const GBK = new TextDecoder("gbk");

export function decodeLine(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    return GBK.decode(bytes);
  }
}

/**
 * Colour and cursor control, which a log pane has no terminal to interpret.
 *
 * `FORCE_COLOR=0` covers the libraries that honour it; plenty of tools write
 * escapes regardless, and `[32m` in a transcript reads as corruption.
 */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** A port a dev server announced, when the caller did not name one. */
const ANNOUNCED_PORT = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d{2,5})\b/i;

export function announcedPort(line: string): number | undefined {
  const hit = ANNOUNCED_PORT.exec(line);
  if (!hit) return undefined;
  const port = Number(hit[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
}

export async function readOutput(
  source: ReadableStream<Uint8Array>,
  onLine: (text: string) => void,
): Promise<void> {
  // Bytes are buffered and decoded a line at a time, not through a streaming
  // decoder: the encoding is decided per line, because a Windows console and a
  // Node tool can disagree about it inside one process's output.
  let pending = new Uint8Array(0);
  let clixml = false;
  const flush = (bytes: Uint8Array) => {
    const text = stripAnsi(decodeLine(bytes)).replace(/\r$/, "");
    // A progress record reaching a redirected PowerShell stream is written
    // as a `#< CLIXML` blob — readable by a CLIXML reader, noise in a log.
    if (text.trimStart().startsWith("#< CLIXML")) {
      clixml = true;
      return;
    }
    if (clixml) {
      // The blob's XML lines follow the marker; the first non-XML line is
      // output again.
      if (text.trimStart().startsWith("<")) return;
      clixml = false;
    }
    if (text.trim().length === 0) return;
    onLine(text);
  };
  try {
    for await (const chunk of source) {
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending);
      merged.set(chunk, pending.length);
      let start = 0;
      for (let i = 0; i < merged.length; i++) {
        if (merged[i] !== 0x0a) continue;
        flush(merged.subarray(start, i));
        start = i + 1;
      }
      pending = merged.subarray(start);
    }
    if (pending.length > 0) flush(pending);
  } catch {
    // The pipe closing under us is how a killed process looks from here.
  }
}
