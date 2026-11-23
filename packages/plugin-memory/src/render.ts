// What the model sees.
//
// Two parts, and the split matters. The protocol is the same every turn, so
// the prompt does not change when the memories do not. The entries are the
// snapshot, and they are what a later session reads instead of the
// conversation that produced them.
//
// The budget is a character count, not a token count: a character is what the
// plugin can measure without a tokenizer, and it is close enough that the
// cap means the same thing on every model. It is a ceiling on everything this
// plugin puts in the prompt — the protocol, the entries, and the note about
// what did not fit — so "6000" means 6000 and not "6000 plus whatever the
// bookkeeping cost". That is the only honest way to answer "how much of my
// context does memory take".
//
// The order of spending is fixed, and it follows from one rule: a memory that
// exists but is invisible is worse than one the model knows it cannot see.
//
// 1. The protocol. It explains the mechanism, so it comes first and it is
//    never traded away. If it does not fit, there is no prompt worth sending.
// 2. The note. When entries are left out, saying so is worth more than any
//    single entry that could have taken its place — and a model that knows
//    there is more can go and fetch it.
// 3. The entries. Newest first, because a stale memory is the dangerous
//    kind, and the workspace before the reader's global preferences, because
//    the workspace's conventions are about the work in front of the agent.
//
// Two things decide what survives the budget, and both were wrong at first:
//
// - The scope. A workspace's own conventions are about the work in front of
//   the agent; the reader's global preferences are about every task. The
//   workspace is more specific, so it is filled first — but it is capped at
//   60%, so a workspace full of notes cannot squeeze the preferences out.
// - The age. The newest memories are the most likely to still be true, and a
//   stale memory is the dangerous kind, so the newest are shown first.

import type { MemoryEntry } from "./types";

/**
 * The fixed half. It says how to use memory, not what the memories are, so
 * it is byte-identical on every turn and every workspace.
 */
export const MEMORY_PROTOCOL = `## Saved memory

These are durable notes from earlier sessions, injected automatically. Each line
starts with an id in brackets: \`memory_update\` changes one, \`memory_remove\`
drops one, \`memory_add\` adds another.

They are notes, not facts about the code. If one is wrong or out of date, say
so and fix it with \`memory_update\` rather than working around it — a stale
memory is worse than no memory.

Save with \`memory_add\` only what a later session would need and cannot read
from the repository: the reader's preferences, this workspace's conventions, a
decision and why it was made, a pitfall that cost time. Do not save what a
file, a test, or git history already says.`;

export const DEFAULT_PROMPT_BUDGET = 6000;

/**
 * The share of the budget the workspace may take before the reader's global
 * memories get the rest. Without it a workspace full of notes would leave
 * nothing for the preferences that apply to every task.
 */
const WORKSPACE_SHARE = 0.6;

/** The blank line between the protocol and what follows. */
const GAP = 2;

/** One entry as the model reads it. */
export function entryLine(entry: MemoryEntry): string {
  return `- [${entry.id}] ${entry.text}`;
}

export interface RenderedPrompt {
  text: string;
  /** How many enabled entries did not fit the budget. */
  omitted: number;
  /** How many enabled entries were shown. */
  shown: number;
  /** Whether anything was injected at all. */
  empty: boolean;
}

interface Filled {
  lines: string[];
  omitted: number;
  /** The length of `lines` once they are joined with newlines. */
  used: number;
}

/** The length of a block of lines once they are joined. */
function joinedLength(lines: string[]): number {
  if (!lines.length) return 0;
  let total = 0;
  for (const line of lines) total += line.length;
  return total + lines.length - 1;
}

/**
 * What the model is told about the part it cannot see.
 *
 * Kept short on purpose: it is paid for out of the same budget as the
 * entries, so every character here is one an entry does not get.
 */
function noteFor(omitted: number): string {
  if (omitted <= 0) return "";
  const subject = omitted === 1 ? "1 memory" : `${omitted} memories`;
  return `(${subject} not shown — use \`memory_list\`)`;
}

/**
 * The entries that fit a cap, in the order given.
 *
 * An entry that does not fit is skipped rather than ending the run: a short
 * memory behind a long one still earns its place, and the budget is there
 * to be spent, not to be left over.
 */
function fill(entries: MemoryEntry[], cap: number): Filled {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const entry of entries) {
    const line = entryLine(entry);
    const cost = line.length + (lines.length ? 1 : 0);
    if (used + cost > cap) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += cost;
  }
  return { lines, omitted, used };
}

/**
 * The two scopes, under one ceiling.
 *
 * The workspace is filled first because it is the more specific half, and it
 * is capped so it cannot take the whole budget. What it leaves is the
 * reader's.
 */
function compose(workspace: MemoryEntry[], global: MemoryEntry[], room: number): Filled {
  const taken = fill(workspace, Math.floor(room * WORKSPACE_SHARE));
  // The two blocks meet with one newline; the global block pays for it.
  const bridge = taken.lines.length ? 1 : 0;
  const rest = fill(global, Math.max(0, room - taken.used - bridge));
  const lines = [...taken.lines, ...rest.lines];
  return { lines, omitted: taken.omitted + rest.omitted, used: joinedLength(lines) };
}

/**
 * The prompt for one session.
 *
 * `workspace` and `global` are the two scopes, each already ordered newest
 * first. Nothing is injected when both are empty: the tool descriptions
 * already say when to save, so a reader who never uses memory pays nothing
 * for it.
 *
 * The budget is a ceiling, not a target: it covers the protocol and the note
 * as well as the entries, so the result never exceeds it.
 */
export function renderPrompt(input: {
  workspace?: MemoryEntry[];
  global?: MemoryEntry[];
  budget?: number;
}): RenderedPrompt {
  const budget = input.budget ?? DEFAULT_PROMPT_BUDGET;
  const workspace = (input.workspace ?? []).filter((entry) => entry.enabled);
  const global = (input.global ?? []).filter((entry) => entry.enabled);
  if (!workspace.length && !global.length) {
    return { text: "", omitted: 0, shown: 0, empty: true };
  }
  // Not even the protocol fits, so there is nothing worth saying: the reader
  // asked for a budget this small and gets silence.
  const fixed = MEMORY_PROTOCOL.length + GAP;
  if (budget <= fixed) {
    return { text: "", omitted: workspace.length + global.length, shown: 0, empty: true };
  }

  // What fits if the entries have the whole room? The note is only paid for
  // when something is actually left out, so the first try does without it.
  let room = budget - fixed;
  let filled = compose(workspace, global, room);

  for (let round = 0; round < 8; round++) {
    if (!filled.omitted) {
      return {
        text: `${MEMORY_PROTOCOL}\n\n${filled.lines.join("\n")}`,
        omitted: 0,
        shown: filled.lines.length,
        empty: false,
      };
    }

    const note = noteFor(filled.omitted);
    // With no entries left there is nothing to put the note next to; it
    // stands on its own, and the model can go and fetch them.
    const total = filled.lines.length
      ? fixed + filled.used + GAP + note.length
      : fixed + GAP + note.length;
    if (total <= budget) {
      const text = filled.lines.length
        ? `${MEMORY_PROTOCOL}\n\n${filled.lines.join("\n")}\n\n${note}`
        : `${MEMORY_PROTOCOL}\n\n${note}`;
      return { text, omitted: filled.omitted, shown: filled.lines.length, empty: false };
    }

    // Too big. Shrink the room by the overflow and try again: dropping an
    // entry frees its characters, and the note grows by at most a digit or
    // two, so this settles after a round or two.
    const next = Math.max(0, room - (total - budget));
    if (next === room) break;
    room = next;
    filled = compose(workspace, global, room);
  }

  // The protocol and the note do not fit together. Half a promise is worse
  // than none: the reader gets nothing rather than a prompt that lies about
  // what was left out.
  return { text: "", omitted: workspace.length + global.length, shown: 0, empty: true };
}
