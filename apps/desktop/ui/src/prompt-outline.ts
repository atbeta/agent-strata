import type { Turn } from "./api";
import { messageText } from "./transcript-format";

export interface PromptEntry {
  /** Row identity in the session — turns are addressed by id, never position. */
  turnId: string;
  /** Position in `turns` — the row the navigator scrolls to. */
  turnIndex: number;
  /** The original turn number, gaps included. Skipped rows keep their count. */
  number: number;
  prompt: string;
  reply: string;
  reverted: boolean;
}

const PROMPT_MAX = 160;
const REPLY_MAX = 240;

/** One line, capped; the suffix keeps the truncation honest at a glance. */
const compact = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};

const fileBase = (path: string): string => {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts.at(-1) ?? path;
};

/**
 * Whether the reader actually wrote something worth an outline row: public
 * text, or an attachment. A turn whose only content is private thinking — or
 * nothing at all — is not a prompt.
 */
const hasPrompt = (turn: Turn): boolean =>
  (turn.user ?? []).some((b) => {
    if (b.type === "text") return b.text.trim() !== "";
    if (b.type === "thinking") return false;
    return true;
  });

/** The last public answer; thinking, tools, and errors never speak for it. */
const replyOf = (turn: Turn): string => {
  for (let i = turn.assistant.length - 1; i >= 0; i--) {
    const text = messageText(turn.assistant[i]!.content);
    if (text.trim()) return compact(text, REPLY_MAX);
  }
  return "";
};

/**
 * Turns are replaced, never mutated, so an entry can outlive the view update
 * that re-derived the list. Reusing it keeps the row's identity stable: the
 * rail's `<For>` then leaves every unchanged tick in the DOM instead of
 * rebuilding all of them on each streaming snapshot.
 */
const entryCache = new WeakMap<Turn, PromptEntry>();

/**
 * One outline entry per turn the reader actually prompted. The list is built
 * from the transcript already on screen — no summarization, no fetch.
 */
export function promptEntries(turns: readonly Turn[]): PromptEntry[] {
  const out: PromptEntry[] = [];
  turns.forEach((turn, turnIndex) => {
    if (!hasPrompt(turn)) return;
    const cached = entryCache.get(turn);
    if (cached && cached.turnIndex === turnIndex) {
      out.push(cached);
      return;
    }
    const text = compact(messageText(turn.user ?? []), PROMPT_MAX);
    const file = (turn.user ?? []).find((b) => b.type === "file_ref");
    const entry: PromptEntry = {
      turnId: turn.turn_id,
      turnIndex,
      number: turnIndex + 1,
      prompt: text || (file && file.type === "file_ref" ? fileBase(file.path) : ""),
      reply: replyOf(turn),
      reverted: Boolean(turn.reverted),
    };
    entryCache.set(turn, entry);
    out.push(entry);
  });
  return out;
}

/**
 * The prompt the top of the viewport belongs to: the nearest entry at or
 * above it — the first when the reader is above even that, undefined when the
 * session has no prompts at all.
 */
export function promptAt(
  entries: readonly PromptEntry[],
  turnIndex: number,
): PromptEntry | undefined {
  if (!entries.length) return undefined;
  let out = entries[0]!;
  for (const entry of entries) {
    if (entry.turnIndex > turnIndex) break;
    out = entry;
  }
  return out;
}
