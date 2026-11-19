import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ResourceResult } from "@agent-strata/plugin-sdk";

export const MAX_BACKGROUND_BYTES = 12 * 1024 * 1024;

export class BackgroundImageError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
  ) {
    super(message);
  }
}

export function detectImageType(bytes: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

export async function readImageRequest(req: Request): Promise<Uint8Array> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BACKGROUND_BYTES) {
    throw new BackgroundImageError("image is too large", 413);
  }
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BACKGROUND_BYTES) {
        await reader.cancel();
        throw new BackgroundImageError("image is too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class BackgroundImageStore {
  private readonly path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "image");
  }

  has(): boolean {
    return existsSync(this.path);
  }

  read(): ResourceResult | undefined {
    if (!this.has()) return undefined;
    const bytes = readFileSync(this.path);
    if (bytes.byteLength > MAX_BACKGROUND_BYTES) return undefined;
    const mime = detectImageType(bytes);
    return mime ? { mime, body: bytes } : undefined;
  }

  write(bytes: Uint8Array): ResourceResult {
    if (bytes.byteLength > MAX_BACKGROUND_BYTES) {
      throw new BackgroundImageError("image is too large", 413);
    }
    const mime = detectImageType(bytes);
    if (!mime) throw new BackgroundImageError("expected a PNG, JPEG, or WebP image", 400);
    const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmp, bytes, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // The temporary file was not created.
      }
      throw error;
    }
    return { mime, body: bytes };
  }

  remove(): void {
    try {
      unlinkSync(this.path);
    } catch {
      // Removing an image that is already absent is idempotent.
    }
  }
}
