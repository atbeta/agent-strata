/** Composer memory that matches the OpenCode desktop: drafts survive a
 * session switch, arrow-up walks previous prompts, and context % is the
 * last assistant message against the model window. */

export interface TokenUsage {
  input: number;
  output: number;
  reasoning?: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ContextTurn {
  assistant: { usage?: TokenUsage }[];
}

export interface SessionContext {
  total: number;
  /** null when the model has no published context window */
  percent: number | null;
  /** the model's published window, null when it reports none */
  limit: number | null;
  /** what the last model call spent, as the backend reported it */
  usage: {
    input: number;
    cache_read: number;
    cache_write: number;
    output: number;
    reasoning: number;
  };
}

/**
 * The last request's size, exactly as the backend reported it.
 *
 * OpenCode usage is per model call and cache-exclusive — `input` counts only
 * the tokens that missed the cache — so the five fields sum to a real
 * per-request total the UI can split without estimating. ACP reports usage
 * aggregated across the session with cache inclusion unspecified, so a
 * non-OpenCode backend gets no context figure rather than a made-up one.
 */
export function sessionContext(
  turns: ContextTurn[],
  limit: number | undefined,
  backend: string | undefined,
): SessionContext | undefined {
  if (backend !== "opencode") return undefined;
  for (let i = turns.length - 1; i >= 0; i--) {
    const assistant = turns[i]?.assistant ?? [];
    for (let j = assistant.length - 1; j >= 0; j--) {
      const usage = assistant[j]?.usage;
      if (!usage) continue;
      const total =
        usage.input + usage.output + (usage.reasoning ?? 0) + (usage.cache_read ?? 0) + (usage.cache_write ?? 0);
      if (total <= 0) continue;
      const percent = limit && limit > 0 ? Math.round((total / limit) * 100) : null;
      return {
        total,
        percent,
        limit: limit && limit > 0 ? limit : null,
        usage: {
          input: usage.input,
          cache_read: usage.cache_read ?? 0,
          cache_write: usage.cache_write ?? 0,
          output: usage.output,
          reasoning: usage.reasoning ?? 0,
        },
      };
    }
  }
  return undefined;
}

export const PROMPT_HISTORY_MAX = 50;
export const PROMPT_HISTORY_KEY = "strata.prompts";

export function draftKey(sessionId: string): string {
  return `strata.draft.${sessionId}`;
}

export function rememberPrompt(entries: string[], text: string, max = PROMPT_HISTORY_MAX): string[] {
  const trimmed = text.trim();
  if (!trimmed) return entries;
  if (entries[0] === trimmed) return entries;
  return [trimmed, ...entries.filter((entry) => entry !== trimmed)].slice(0, max);
}

export function canNavigateHistory(
  direction: "up" | "down",
  text: string,
  cursor: number,
  inHistory: boolean,
): boolean {
  const position = Math.max(0, Math.min(cursor, text.length));
  if (inHistory) return position === 0 || position === text.length;
  return direction === "up" && position === 0 && text.length === 0;
}

export interface HistoryMove {
  handled: boolean;
  index: number;
  text: string;
  cursor: "start" | "end";
}

export function navigateHistory(input: {
  direction: "up" | "down";
  text: string;
  cursor: number;
  index: number;
  entries: string[];
  saved: string;
}): HistoryMove {
  const stay = (): HistoryMove => ({
    handled: false,
    index: input.index,
    text: input.text,
    cursor: "end",
  });
  const inHistory = input.index >= 0;
  if (!canNavigateHistory(input.direction, input.text, input.cursor, inHistory)) return stay();

  if (input.direction === "up") {
    const next = inHistory ? input.index + 1 : 0;
    if (next >= input.entries.length) return stay();
    return { handled: true, index: next, text: input.entries[next] ?? "", cursor: "start" };
  }

  if (!inHistory) return stay();
  if (input.index === 0) return { handled: true, index: -1, text: input.saved, cursor: "end" };
  const next = input.index - 1;
  return { handled: true, index: next, text: input.entries[next] ?? "", cursor: "end" };
}

export function readDraft(sessionId: string): string {
  try {
    return localStorage.getItem(draftKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

export function writeDraft(sessionId: string, text: string): void {
  try {
    const key = draftKey(sessionId);
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    // private mode
  }
}

export function readHistory(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PROMPT_HISTORY_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

export function writeHistory(entries: string[]): void {
  try {
    localStorage.setItem(PROMPT_HISTORY_KEY, JSON.stringify(entries.slice(0, PROMPT_HISTORY_MAX)));
  } catch {
    // private mode
  }
}

/**
 * Messages waiting in a session's queue, as text.
 *
 * A queue entry is a promise to send, so it must not survive a restart as one:
 * reopening the app hours later and having it fire off what the reader typed
 * before lunch is worse than losing it. What is kept here is only the words, and
 * they are read back into the draft — where the reader decides — rather than
 * into the queue.
 *
 * Text only, and that is not an oversight: an attachment travels as a data URL
 * of up to 5MB each, ten of them per message, against a localStorage quota of
 * about 5MB in total. There is no version of this that stores them. A restored
 * queue therefore says what it can and the reader re-attaches what it cannot.
 */
export function queuedKey(sessionId: string): string {
  return `strata.queued.${sessionId}`;
}

type ReadStorage = Pick<Storage, "getItem"> | undefined;
type WriteStorage = Pick<Storage, "setItem" | "removeItem"> | undefined;

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readQueuedText(sessionId: string, storage: ReadStorage = browserStorage()): string[] {
  try {
    const raw = storage?.getItem(queuedKey(sessionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.trim() !== "");
  } catch {
    return [];
  }
}

export function writeQueuedText(
  sessionId: string,
  texts: readonly string[],
  storage: WriteStorage = browserStorage(),
): void {
  try {
    const key = queuedKey(sessionId);
    const kept = texts.filter((t) => t.trim() !== "");
    if (kept.length) storage?.setItem(key, JSON.stringify(kept));
    else storage?.removeItem(key);
  } catch {
    // Private mode, or a quota that will not take it: the queue still works
    // for this run, it just will not come back after a restart.
  }
}

/**
 * Messages waiting for a session, taken out of storage.
 *
 * Read-and-clear in one step: what comes back is about to be shown in the
 * draft, and leaving it in storage would fold it in again on the next open.
 */
export function takeQueuedText(sessionId: string, storage?: Storage): string[] {
  const texts = readQueuedText(sessionId, storage);
  if (texts.length) writeQueuedText(sessionId, [], storage);
  return texts;
}

/**
 * A draft with the messages that were waiting put back in front of it.
 *
 * One message per line, in the order they were queued, above whatever was
 * typed. They arrive as text because that is all that can survive a restart —
 * see `queuedKey`.
 */
export function joinQueued(typed: string, waiting: readonly string[]): string {
  const rest = waiting.filter((t) => t.trim() !== "");
  if (!rest.length) return typed;
  return typed.trim() ? `${typed}\n${rest.join("\n")}` : rest.join("\n");
}
