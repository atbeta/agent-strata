import { basename, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { OpencodePromptPart } from "@agent-strata/adapter-opencode";
import type { PromptPart } from "./driver";

export type OpencodeFilePart = Extract<OpencodePromptPart, { type: "file" }>;

/**
 * Text that lives under a non-`text/` mime. OpenCode only inlines file parts
 * declared `text/plain` and hands every other mime to the provider as media,
 * where models reject types like `application/json` before seeing the content.
 */
const TEXTUAL_MIME = new Set([
  "application/json",
  "application/ld+json",
  "application/x-ndjson",
  "application/xml",
  "application/xhtml+xml",
  "application/rss+xml",
  "application/atom+xml",
  "application/javascript",
  "application/x-javascript",
  "application/typescript",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/x-toml",
  "application/sql",
  "application/graphql",
  "application/csv",
  "application/rtf",
  "application/x-sh",
  "application/x-httpd-php",
  "application/x-perl",
  "application/x-python",
  "application/x-ruby",
  "image/svg+xml",
]);

/**
 * Whether the attachment's payload is text a model can read. The mime check
 * covers the common declarations; anything else, typically an extension-less
 * `application/octet-stream`, is decided by decoding the data URL itself.
 */
function isTextualAttachment(p: Extract<PromptPart, { type: "attachment" }>): boolean {
  const mime = p.mime.toLowerCase();
  if (mime.startsWith("text/") || TEXTUAL_MIME.has(mime) || /\+(json|xml)$/.test(mime)) return true;
  const comma = p.url.indexOf(",");
  if (comma === -1) return false;
  try {
    return !new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(p.url.slice(comma + 1), "base64")).includes("\u0000");
  } catch {
    return false;
  }
}

/** OpenCode reads a `file://` part itself, so a workspace file goes by its absolute URL. */
export function toOpencodeParts(parts: PromptPart[], directory: string | undefined): OpencodePromptPart[] {
  return parts.map((p): OpencodePromptPart => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "attachment") {
      const mime = isTextualAttachment(p) ? "text/plain" : p.mime;
      return {
        type: "file",
        mime,
        url: mime === p.mime ? p.url : p.url.replace(/^data:[^;,]*/, `data:${mime}`),
        ...(p.filename ? { filename: p.filename } : {}),
      };
    }
    if (!directory) throw new Error("this session has no workspace to read files from");
    const abs = resolve(directory, p.path);
    const rel = relative(directory, abs);
    if (isAbsolute(rel) || rel.split(/[\\/]/)[0] === "..") throw new Error(`${p.path} is outside the workspace`);
    const value = `@${p.path}`;
    return {
      type: "file",
      mime: "text/plain",
      filename: basename(p.path),
      url: pathToFileURL(abs).href,
      source: {
        type: "file",
        path: p.path,
        // no mention in the text: a zero-width range keeps `source.path` without claiming any characters
        text: p.mention ? { value, start: p.mention.start, end: p.mention.end } : { value, start: 0, end: 0 },
      },
    };
  });
}
