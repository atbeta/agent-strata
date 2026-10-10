import { isAbsolute } from "node:path";
import type { PromptPart } from "./driver";

export const ATTACHMENT_MIMES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const inWorkspace = (path: string) =>
  path.length > 0 && !isAbsolute(path) && !/^[a-zA-Z]:/.test(path) && !/^[\\/]/.test(path) && !path.split(/[\\/]/).includes("..");

function readPart(p: unknown): PromptPart | string {
  if (!p || typeof p !== "object") return "not an object";
  const o = p as Record<string, unknown>;
  if (o.type === "text") return typeof o.text === "string" ? { type: "text", text: o.text } : "text must be a string";
  if (o.type === "file_ref") {
    if (typeof o.path !== "string" || !inWorkspace(o.path)) return "workspace";
    const m = o.mention as { start?: unknown; end?: unknown } | undefined;
    if (m === undefined) return { type: "file_ref", path: o.path };
    if (!m || typeof m !== "object") return "mention must be 0 <= start < end";
    if (!Number.isInteger(m.start) || !Number.isInteger(m.end) || (m.start as number) < 0 || (m.end as number) <= (m.start as number))
      return "mention must be 0 <= start < end";
    return { type: "file_ref", path: o.path, mention: { start: m.start as number, end: m.end as number } };
  }
  if (o.type === "attachment") {
    if (typeof o.mime !== "string" || !ATTACHMENT_MIMES.has(o.mime)) return "attachments must be an image or PDF";
    if (typeof o.url !== "string" || !o.url.startsWith(`data:${o.mime};base64,`)) return "attachment url must be a data URL of its mime";
    const encoded = o.url.length - o.url.indexOf(",") - 1;
    if ((encoded * 3) / 4 > MAX_ATTACHMENT_BYTES) return "attachments are limited to 5 MB";
    if (o.filename !== undefined && typeof o.filename !== "string") return "filename must be a string";
    return { type: "attachment", mime: o.mime, url: o.url, ...(o.filename ? { filename: o.filename as string } : {}) };
  }
  return "unknown type";
}

/** The parts a request asks to send, or why they cannot be sent. */
export function readPromptParts(body: { parts?: unknown; text?: unknown } | null): PromptPart[] | { error: string } {
  const raw: unknown[] =
    Array.isArray(body?.parts) ? body.parts : typeof body?.text === "string" ? [{ type: "text", text: body.text }] : [];
  const parts: PromptPart[] = [];
  for (const [i, p] of raw.entries()) {
    const r = readPart(p);
    if (typeof r === "string")
      return { error: r === "workspace" ? `part ${i}: path must stay inside the session's workspace` : `part ${i}: ${r}` };
    parts.push(r);
  }
  const something = parts.some((p) => p.type !== "text" || p.text.trim() !== "");
  return something ? parts : { error: "text or parts required" };
}
