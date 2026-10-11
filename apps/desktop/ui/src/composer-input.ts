import type { CommandPart, PromptPart } from "./api";

/** An `@file` mention or a leading `/command` the caret is in the middle of typing. */
export interface Trigger {
  kind: "file" | "command";
  query: string;
  start: number;
  end: number;
}

/** An `@` right after one of these is part of an email address, not a mention. */
const ADDRESS_CHAR = /[A-Za-z0-9._%+-]/;
const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}`;
/** Trailing punctuation is left out of a mention as long as a word boundary follows it. */
const MENTION_END = new RegExp(String.raw`^[,.;:!?)\]}'"，。；：！？）】」、]*(?:$|\s|[${CJK}])`, "u");

const opensMention = (text: string, at: number) => at === 0 || !ADDRESS_CHAR.test(text[at - 1]!);

export function triggerAt(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const slash = /^\/(\S*)$/.exec(before);
  if (slash) return { kind: "command", query: slash[1]!, start: 0, end: caret };
  const wordStart = caret - /\S*$/.exec(before)![0].length;
  for (let i = before.indexOf("@", wordStart); i >= 0; i = before.indexOf("@", i + 1)) {
    if (opensMention(before, i)) return { kind: "file", query: before.slice(i + 1), start: i, end: caret };
  }
  return undefined;
}

/** `.` and `:` are left out: they occur inside paths. */
const CLOSERS = String.raw`,;!?)\]}'"，。；：！？）】」、`;
const CLOSING = new RegExp(`^[${CLOSERS}]`);
const WORD_REST = new RegExp(String.raw`^[^\s${CLOSERS}]*`);

/**
 * The rest of the word under the caret goes too, so editing a mention mid-word
 * replaces all of it — up to closing punctuation, which stays put.
 */
export function insertPick(text: string, t: Trigger, pick: string): { text: string; caret: number } {
  const token = `${t.kind === "file" ? "@" : "/"}${pick}`;
  const rest = text.slice(t.end).replace(WORD_REST, "");
  const closed = CLOSING.test(rest);
  const tail = closed ? rest : ` ${rest.replace(/^ /, "")}`;
  return { text: `${text.slice(0, t.start)}${token}${tail}`, caret: t.start + token.length + (closed ? 0 : 1) };
}

function mentions(text: string, picked: readonly string[]): { path: string; start: number; end: number }[] {
  const out: { path: string; start: number; end: number }[] = [];
  for (const path of new Set(picked)) {
    const token = `@${path}`;
    for (let i = text.indexOf(token); i >= 0; i = text.indexOf(token, i + 1)) {
      const end = i + token.length;
      if (opensMention(text, i) && MENTION_END.test(text.slice(end))) {
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

/** One message on its way out: what the draft held when it was sent. */
export interface Outgoing {
  text: string;
  picked: string[];
  attachments: Attachment[];
  /** user turn to revert before this send; set by edit-and-resend */
  revertTurnId?: string;
}

/** The service says this when a prompt was refused or never accepted. */
export const PROMPT_NOT_ACCEPTED = "prompt was not accepted";

/** A refused send shows the fallback, so the draft text is not repeated in the error. */
export function explainSend(message: string, fallback: string): string {
  const text = message.replace(/^Error:\s*/, "");
  if (!text || text === PROMPT_NOT_ACCEPTED) return fallback;
  return text;
}

/** A send that failed goes back in front of whatever was typed since, so neither is lost. */
export function restoreFailed(failed: Outgoing, current: Outgoing): { draft: Outgoing; dropped: number } {
  const typed = current.text.trim() ? current.text : "";
  const text = failed.text && typed ? `${failed.text}\n${typed}` : failed.text || typed;
  const attachments = [...failed.attachments, ...current.attachments];
  return {
    draft: {
      text,
      picked: [...new Set([...failed.picked, ...current.picked])],
      attachments: attachments.slice(0, MAX_ATTACHMENTS),
    },
    dropped: Math.max(0, attachments.length - MAX_ATTACHMENTS),
  };
}

/** A command takes its words as arguments, so there is no text part for a mention to point into. */
export function commandParts(draft: string, picked: readonly string[], attachments: readonly Attachment[]): CommandPart[] {
  return promptParts(draft, picked, attachments).flatMap((p): CommandPart[] =>
    p.type === "file_ref" ? [{ type: "file_ref", path: p.path }] : p.type === "attachment" ? [p] : [],
  );
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
export const MAX_ATTACHMENTS = 10;

export function attachmentProblem(file: { type: string; size: number }): "type" | "size" | undefined {
  if (!ATTACHMENT_MIMES.has(file.type)) return "type";
  if (file.size > MAX_ATTACHMENT_BYTES) return "size";
  return undefined;
}

export async function toAttachment(file: File, id: string): Promise<Attachment> {
  if (!file.type) throw new Error(`${file.name} has no type`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { id, name: file.name, mime: file.type, url: `data:${file.type};base64,${btoa(binary)}` };
}
