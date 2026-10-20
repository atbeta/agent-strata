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
