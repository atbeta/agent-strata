import { isAbsolute } from "node:path";
import type { PromptPart } from "./driver";

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

/**
 * A mime type as a browser or a client library would write it.
 *
 * The type itself is not restricted: OpenCode hands a file part to the model
 * whatever it is, and the model decides whether it can read it. What is checked
 * is that the declared type is a mime type at all, so the value that reaches the
 * backend cannot be an arbitrary string in a field the adapter formats into a
 * data URL.
 */
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

const inWorkspace = (path: string) =>
  path.length > 0 && !isAbsolute(path) && !/^[a-zA-Z]:/.test(path) && !/^[\\/]/.test(path) && !path.split(/[\\/]/).includes("..");

function readPart(p: unknown): PromptPart | string {
  if (!p || typeof p !== "object") return "not an object";
  const o = p as Record<string, unknown>;
  if (o.type === "text") return typeof o.text === "string" ? { type: "text", text: o.text } : "text must be a string";
  if (o.type === "file_ref") {
    if (typeof o.path !== "string") return "path must be a string";
    const path = o.path.replace(/\\/g, "/");
    if (!inWorkspace(path)) return "path must stay inside the session's workspace";
    const m = o.mention as { start?: unknown; end?: unknown } | null | undefined;
    if (m === undefined) return { type: "file_ref", path };
    if (!m || typeof m !== "object") return "mention must be 0 <= start < end";
    if (!Number.isInteger(m.start) || !Number.isInteger(m.end) || (m.start as number) < 0 || (m.end as number) <= (m.start as number))
      return "mention must be 0 <= start < end";
    return { type: "file_ref", path, mention: { start: m.start as number, end: m.end as number } };
  }
  if (o.type === "attachment") {
    if (typeof o.mime !== "string" || !MIME.test(o.mime)) return "attachment mime must be a mime type";
    const prefix = `data:${o.mime};base64,`;
    if (typeof o.url !== "string" || !o.url.startsWith(prefix)) return "attachment url must be a data URL of its mime";
    const payload = o.url.slice(prefix.length);
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    if ((payload.length * 3) / 4 - padding > MAX_ATTACHMENT_BYTES) return "attachments are limited to 5 MB";
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return "attachment url must be base64";
    if (o.filename !== undefined && typeof o.filename !== "string") return "filename must be a string";
    return { type: "attachment", mime: o.mime, url: o.url, ...(o.filename ? { filename: o.filename as string } : {}) };
  }
  return "unknown type";
}

/** The parts a request asks to send, or why they cannot be sent. */
export function readPromptParts(body: { parts?: unknown; text?: unknown } | null): PromptPart[] | { error: string } {
  if (body?.parts !== undefined && !Array.isArray(body.parts)) return { error: "parts must be an array" };
  const raw: unknown[] =
    Array.isArray(body?.parts) ? body.parts : typeof body?.text === "string" ? [{ type: "text", text: body.text }] : [];
  const parts: PromptPart[] = [];
  for (const [i, p] of raw.entries()) {
    const r = readPart(p);
    if (typeof r === "string") return { error: `part ${i}: ${r}` };
    parts.push(r);
  }
  if (parts.filter((p) => p.type === "attachment").length > MAX_ATTACHMENTS)
    return { error: `at most ${MAX_ATTACHMENTS} attachments per prompt` };
  const first = parts.find((p) => p.type === "text")?.text;
  for (const [i, p] of parts.entries()) {
    if (p.type !== "file_ref" || !p.mention) continue;
    if (first === undefined) return { error: `part ${i}: mention needs a text part to point into` };
    if (p.mention.end > first.length) return { error: `part ${i}: mention runs past the end of the text` };
    if (first.slice(p.mention.start, p.mention.end) !== `@${p.path}`)
      return { error: `part ${i}: mention does not point at @${p.path} in the text` };
  }
  const something = parts.some((p) => p.type !== "text" || p.text.trim() !== "");
  return something ? parts : { error: "text or parts required" };
}
