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
  /**
   * What the last model call spent, as the backend reported it.
   *
   * `input` here is the non-cached prompt; `total` below is the retained
   * context, not this object's sum.
   */
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
 * the tokens that missed the cache. The context this session carries into the
 * next turn is the prompt, not the reply: output and reasoning are generated,
 * reasoning is never carried forward, so counting them would report a window
 * fuller than it is. OpenCode's own desktop computes the same way.
 *
 * ACP reports usage aggregated across the session with cache inclusion
 * unspecified, so a non-OpenCode backend gets no context figure rather than a
 * made-up one.
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
      // Retained context, not the call's whole bill: the reply is generated and
      // the next turn's window does not hold it.
      const total = usage.input + (usage.cache_read ?? 0) + (usage.cache_write ?? 0);
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

function readStoredDraft(sessionId: string): string {
  try {
    return localStorage.getItem(draftKey(sessionId)) ?? "";
  } catch {
    return "";
  }
}

function writeStoredDraft(sessionId: string, text: string): void {
  try {
    const key = draftKey(sessionId);
    if (text) localStorage.setItem(key, text);
    else localStorage.removeItem(key);
  } catch {
    // private mode
  }
}

export interface DraftWriter {
  /** remember the newest draft; a clear lands at once, a write on the next tick */
  schedule(sessionId: string, text: string): void;
  /** the text still queued for this session, before storage has it */
  pendingText(sessionId: string): string | undefined;
  /** write whatever is queued — for unmount and the page going away */
  flush(): void;
}

/**
 * A draft is kept so a crash or a closed window does not eat it; it is not a
 * keystroke log. Writing the whole string to storage on every input event is
 * the composer's biggest per-key cost once the text is heavy, so writes are
 * throttled: the newest text wins whenever the timer fires, and `flush` is
 * the guarantee for the moment storage becomes the only copy. A clear is
 * never deferred — a sent message dropping its draft has to beat whatever
 * write is still queued.
 */
export function createDraftWriter(deps: {
  write: (sessionId: string, text: string) => void;
  delayMs?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
}): DraftWriter {
  const delay = deps.delayMs ?? 400;
  const later = deps.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
  const cancel = deps.clearTimeout ?? ((t: unknown) => clearTimeout(t as Parameters<typeof clearTimeout>[0]));
  let pending: { id: string; text: string } | undefined;
  let timer: unknown;
  const flush = (): void => {
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
    if (!pending) return;
    deps.write(pending.id, pending.text);
    pending = undefined;
  };
  return {
    schedule(sessionId, text) {
      // A different session's words are not this write's to replace: on a
      // switch the old session's text lands before the new one's queues.
      if (pending && pending.id !== sessionId) flush();
      if (!text) {
        pending = undefined;
        if (timer !== undefined) {
          cancel(timer);
          timer = undefined;
        }
        deps.write(sessionId, text);
        return;
      }
      pending = { id: sessionId, text };
      timer ??= later(() => {
        timer = undefined;
        flush();
      }, delay);
    },
    pendingText(sessionId) {
      return pending?.id === sessionId ? pending.text : undefined;
    },
    flush,
  };
}

/**
 * The one writer every reader shares. `readDraft` answers what the writer
 * still holds, so a draft queued behind the throttle is as visible as one
 * already on disk — anything deciding on the storage copy alone, like a
 * fresh-session prune, would call a typed-but-unflushed session empty.
 */
const drafts = createDraftWriter({ write: writeStoredDraft });

export function readDraft(sessionId: string): string {
  return drafts.pendingText(sessionId) ?? readStoredDraft(sessionId);
}

/** Queue the session's draft — the per-keystroke path. */
export function scheduleDraft(sessionId: string, text: string): void {
  drafts.schedule(sessionId, text);
}

/** Land every queued draft now — before storage becomes the only copy. */
export function flushDrafts(): void {
  drafts.flush();
}

export function writeDraft(sessionId: string, text: string): void {
  drafts.schedule(sessionId, text);
  drafts.flush();
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
 *
 * Waiting messages go first because they were written first. The other order —
 * what this used to do — put them *after* whatever the reader had since typed,
 * so reopening a session read as "your old messages were appended to the end of
 * my new one", and a send took the whole pile with it. `restoreFailed` already
 * orders it this way for the in-memory case; this is the same rule for the
 * stored one.
 */
export function joinQueued(typed: string, waiting: readonly string[]): string {
  const rest = waiting.filter((t) => t.trim() !== "");
  if (!rest.length) return typed;
  return typed.trim() ? `${rest.join("\n")}\n${typed}` : rest.join("\n");
}
