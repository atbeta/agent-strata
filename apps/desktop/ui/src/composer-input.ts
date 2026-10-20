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
  if (!m) return undefined;
  const typed = m[1]!.toLowerCase();
  const name = names.find((n) => n.toLowerCase() === typed);
  if (!name) return undefined;
  return { name, args: (m[2] ?? "").trim() };
}

export interface SlashEntry {
  name: string;
  source?: "builtin" | "command" | "mcp" | "skill";
  /** the command cannot run until the reader types something after the name */
  argument?: boolean;
}

/** Built-ins that cannot run until the reader has typed an argument. */
function needsArgument(entry: SlashEntry): boolean {
  return entry.argument === true || (entry.source === "builtin" && entry.name.toLowerCase() === "rename");
}

export interface HandoffCandidate {
  id: string;
  label: string;
  /** shown beside a label that would otherwise name two backends */
  detail: string;
  prompt: boolean;
}

export interface HandoffTarget {
  id: string;
  label: string;
}

/**
 * Backends that can open a session and are not the one already driving this one.
 *
 * A handoff is a new session. The connection that owns the source is not a
 * destination: continuing there is a prompt, which the composer already sends.
 */
export function handoffTargets(connections: readonly HandoffCandidate[], ownerId: string | undefined): HandoffTarget[] {
  const eligible = connections.filter((connection) => connection.prompt && connection.id !== ownerId);
  const counts = new Map<string, number>();
  for (const connection of eligible) counts.set(connection.label, (counts.get(connection.label) ?? 0) + 1);
  return eligible.map((connection) => ({
    id: connection.id,
    label: (counts.get(connection.label) ?? 0) > 1 ? `${connection.label} ${connection.detail}` : connection.label,
  }));
}

/** The backend a `/handoff` argument names. An empty argument means the only one. */
export function resolveHandoff(targets: readonly HandoffTarget[], arg: string): HandoffTarget | undefined {
  const query = arg.trim().toLowerCase();
  if (!query) return targets.length === 1 ? targets[0] : undefined;
  const exact = targets.filter((target) => target.id.toLowerCase() === query || target.label.toLowerCase() === query);
  if (exact.length === 1) return exact[0];
  const partial = targets.filter((target) => target.label.toLowerCase().includes(query));
  return partial.length === 1 ? partial[0] : undefined;
}

/**
 * Enter while a slash command is being typed.
 *
 * A finished name runs even when the highlighted row is a different command,
 * so `/compact` does not get rewritten into whatever sits on the first row.
 * A prefix runs only when that row is a built-in that takes no argument;
 * anything that still wants words is completed instead.
 */
export function slashMenuEnter(input: {
  draft: string;
  highlighted?: string;
  commands: readonly SlashEntry[];
}): { action: "run"; name: string; args: string } | { action: "insert"; name: string } | { action: "prompt" } {
  const typed = commandOf(input.draft, input.commands.map((c) => c.name));
  if (typed) {
    const entry = input.commands.find((c) => c.name === typed.name);
    if (entry && needsArgument(entry) && !typed.args) return { action: "insert", name: typed.name };
    return { action: "run", name: typed.name, args: typed.args };
  }
  if (input.highlighted) {
    const entry = input.commands.find((c) => c.name === input.highlighted);
    if (entry?.source === "builtin" && !needsArgument(entry)) return { action: "run", name: entry.name, args: "" };
    return { action: "insert", name: input.highlighted };
  }
  return { action: "prompt" };
}

/** Click or Tab on a slash row: a built-in with no argument runs, the rest is inserted. */
export function slashRowSelect(input: { name: string; commands: readonly SlashEntry[] }):
  | { action: "run"; name: string; args: string }
  | { action: "insert"; name: string } {
  const entry = input.commands.find((c) => c.name === input.name);
  if (entry?.source === "builtin" && !needsArgument(entry)) return { action: "run", name: entry.name, args: "" };
  return { action: "insert", name: input.name };
}

export function matchCommands<T extends { name: string }>(list: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  const name = (c: T) => c.name.toLowerCase();
  return [...list.filter((c) => name(c).startsWith(q)), ...list.filter((c) => !name(c).startsWith(q) && name(c).includes(q))];
}

/**
 * Slash commands the app runs itself rather than handing to the backend.
 *
 * A CLI's `/` menu mixes these with the backend's prompt commands; the backend
 * only ever lists the second kind, so without this table commands like
 * `/compact` — a client-side action that calls the summarize endpoint — never
 * appear at all. Each entry is gated on what the session can actually do.
 */
export function builtinCommands(c: {
  summarize?: boolean;
  revert?: boolean;
  /** the session holds a reverted state `redo` can restore */
  reverted?: boolean;
  abort?: boolean;
  fork?: boolean;
  /** some other connected backend can open a session */
  handoff?: boolean;
  hasTurns?: boolean;
  manage?: boolean;
  share?: boolean;
  terminal?: boolean;
}): string[] {
  const names: string[] = [];
  if (c.summarize) names.push("compact", "summarize");
  if (c.revert) {
    names.push("undo");
    if (c.reverted) names.push("redo");
  }
  if (c.abort) names.push("interrupt");
  if (c.fork && c.hasTurns) names.push("fork");
  if (c.handoff) names.push("handoff");
  if (c.manage) names.push("rename");
  if (c.share) names.push("share", "unshare");
  if (c.terminal) names.push("terminal");
  names.push("export", "new");
  return names;
}

export function nextAgent(agents: readonly string[], current: string, step: 1 | -1): string | undefined {
  if (agents.length === 0) return undefined;
  const i = agents.indexOf(current);
  if (i < 0) return step > 0 ? agents[0] : agents[agents.length - 1];
  return agents[(i + step + agents.length) % agents.length];
}

/**
 * One step along `agents`, stopping at the ends.
 *
 * `nextAgent` wraps because a cycler should. Tab must not: bound to the
 * wrapping one, Tab never reached the end of the list, so the composer became
 * a focus trap — no way out to the toolbar, the sidebar, or anything behind the
 * input, by Tab or by Shift+Tab. Undefined means there is no neighbour, which
 * is the caller saying the key belongs to the browser again.
 */
export function stepAgent(agents: readonly string[], current: string, step: 1 | -1): string | undefined {
  if (agents.length === 0) return undefined;
  const i = agents.indexOf(current);
  if (i < 0) return step > 0 ? agents[0] : agents[agents.length - 1];
  const j = i + step;
  return j >= 0 && j < agents.length ? agents[j] : undefined;
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
