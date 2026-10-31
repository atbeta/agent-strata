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

const WS = /\s/;

/**
 * One line, capped; the suffix keeps the truncation honest at a glance.
 * The collapse runs token by token and stops once max+1 characters are
 * emitted — past that the answer cannot change, so a pasted megabyte costs
 * ~max rather than ~n. `out` is always the trimmed collapsed prefix:
 * separators are emitted lazily so it never begins or ends with a space.
 */
const compact = (text: string, max: number): string => {
  const run = /\s+|[^\s]+/g;
  let out = "";
  let gap = false;
  for (let m = run.exec(text); m && out.length <= max; m = run.exec(text)) {
    const tok = m[0];
    if (WS.test(tok[0]!)) {
      if (out) gap = true;
      continue;
    }
    if (gap) out += " ";
    gap = false;
    out += out.length + tok.length > max + 1 ? tok.slice(0, max + 1 - out.length) : tok;
  }
  return out.length > max ? `${out.slice(0, max - 3)}...` : out;
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
 *
 * The cache is keyed by the turn object. A streaming reply replaces that
 * object, so the caller also passes the entries it built last time: the same
 * prompt at the same index keeps the same entry, and only the reply cell
 * moves. The tick under a hovering pointer then stays the node it already is.
 */
const entryCache = new WeakMap<Turn, PromptEntry>();
const replyCells = new WeakMap<PromptEntry, { turn: Turn; text?: string }>();

const retarget = (entry: PromptEntry, turn: Turn) => {
  const cell = replyCells.get(entry);
  if (!cell || cell.turn === turn) return;
  cell.turn = turn;
  cell.text = undefined;
};

/**
 * One outline entry per turn the reader actually prompted. The list is built
 * from the transcript already on screen — no summarization, no fetch.
 *
 * `previous` is the list this session already handed the rail. Pass it so an
 * assistant-only update does not mint a new entry for the same prompt.
 */
export function promptEntries(turns: readonly Turn[], previous?: readonly PromptEntry[]): PromptEntry[] {
  const prevById = previous?.length ? new Map(previous.map((e) => [e.turnId, e])) : undefined;
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
    const prompt = text || (file && file.type === "file_ref" ? fileBase(file.path) : "");
    const reverted = Boolean(turn.reverted);
    const carried = prevById?.get(turn.turn_id);
    if (carried && carried.turnIndex === turnIndex && carried.prompt === prompt && carried.reverted === reverted) {
      retarget(carried, turn);
      entryCache.set(turn, carried);
      out.push(carried);
      return;
    }
    // The reply only shows in the hover card, so it is computed on first
    // read: building it for every row made opening a long session pay for
    // a thousand cards nobody hovers.
    const cell: { turn: Turn; text?: string } = { turn };
    const entry: PromptEntry = {
      turnId: turn.turn_id,
      turnIndex,
      number: turnIndex + 1,
      prompt,
      get reply() {
        return (cell.text ??= replyOf(cell.turn));
      },
      reverted,
    };
    replyCells.set(entry, cell);
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
  // Binary search for the last entry at or before the row: the outline rail
  // asks on every scroll frame, and a linear scan over a long session was the
  // frame itself. Entries arrive ascending by turnIndex by construction.
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid]!.turnIndex <= turnIndex) lo = mid + 1;
    else hi = mid;
  }
  return entries[Math.max(0, lo - 1)];
}
