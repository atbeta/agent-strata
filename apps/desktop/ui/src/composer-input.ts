import type { PromptPart } from "./api";

/** An `@file` mention or a leading `/command` the caret is in the middle of typing. */
export interface Trigger {
  kind: "file" | "command";
  query: string;
  start: number;
  end: number;
}

export function triggerAt(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { kind: "command", query: slash[1]!, start: 0, end: caret };
  const at = /(?:^|\s)@(\S*)$/.exec(before);
  if (at) return { kind: "file", query: at[1]!, start: caret - at[1]!.length - 1, end: caret };
  return undefined;
}

/** The rest of the word under the caret goes too, so editing a mention mid-word replaces all of it. */
export function insertPick(text: string, t: Trigger, pick: string): { text: string; caret: number } {
  const token = `${t.kind === "file" ? "@" : "/"}${pick}`;
  const after = text.slice(t.end).replace(/^\S*/, "").replace(/^\s/, "");
  return { text: `${text.slice(0, t.start)}${token} ${after}`, caret: t.start + token.length + 1 };
}

function mentions(text: string, picked: readonly string[]): { path: string; start: number; end: number }[] {
  const out: { path: string; start: number; end: number }[] = [];
  for (const path of new Set(picked)) {
    const token = `@${path}`;
    for (let i = text.indexOf(token); i >= 0; i = text.indexOf(token, i + 1)) {
      const end = i + token.length;
      if ((i === 0 || /\s/.test(text[i - 1]!)) && (end === text.length || /\s/.test(text[end]!))) {
        out.push({ path, start: i, end });
        break;
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  /** data: URL */
  url: string;
}

/** A file picked from the menu goes along only while the draft still mentions it. */
export function promptParts(draft: string, picked: readonly string[], attachments: readonly Attachment[]): PromptPart[] {
  const text = draft.trim();
  const parts: PromptPart[] = text ? [{ type: "text", text }] : [];
  for (const m of mentions(text, picked)) parts.push({ type: "file_ref", path: m.path, mention: { start: m.start, end: m.end } });
  for (const a of attachments) parts.push({ type: "attachment", mime: a.mime, url: a.url, filename: a.name });
  return parts;
}

export function commandOf(draft: string, names: readonly string[]): { name: string; args: string } | undefined {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(draft.trim());
  if (!m || !names.includes(m[1]!)) return undefined;
  return { name: m[1]!, args: (m[2] ?? "").trim() };
}

export function matchCommands<T extends { name: string }>(list: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  const name = (c: T) => c.name.toLowerCase();
  return [...list.filter((c) => name(c).startsWith(q)), ...list.filter((c) => !name(c).startsWith(q) && name(c).includes(q))];
}

export function nextAgent(agents: readonly string[], current: string, step: 1 | -1): string | undefined {
  if (agents.length === 0) return undefined;
  const i = agents.indexOf(current);
  if (i < 0) return step > 0 ? agents[0] : agents[agents.length - 1];
  return agents[(i + step + agents.length) % agents.length];
}

export const ATTACHMENT_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf";
const ATTACHMENT_MIMES = new Set(ATTACHMENT_ACCEPT.split(","));
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export function attachmentProblem(file: { type: string; size: number }): "type" | "size" | undefined {
  if (!ATTACHMENT_MIMES.has(file.type)) return "type";
  if (file.size > MAX_ATTACHMENT_BYTES) return "size";
  return undefined;
}

export async function toAttachment(file: File, id: string): Promise<Attachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { id, name: file.name, mime: file.type, url: `data:${file.type};base64,${btoa(binary)}` };
}
