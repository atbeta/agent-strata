// SessionView → a compact, model-readable transcript.
//
// The store keeps CASF events; nobody should read those raw. This is the one
// place a session becomes text an agent can scan: a header with the facts the
// projector already decided (status, parent, workspace), then one block per
// turn. Thinking stays out — it is the model's scratch work, not memory — and
// every field is capped so one turn cannot crowd the rest of the page out.

import type { ContentBlock } from "@agent-strata/schema";
import type { SessionView, ToolCallView, Turn } from "@agent-strata/projector";

export interface DigestLimits {
  /** per text block */
  textCap: number;
  /** per tool input (compact JSON) */
  inputCap: number;
  /** per tool output */
  outputCap: number;
}

export const DIGEST_LIMITS: DigestLimits = { textCap: 1500, inputCap: 160, outputCap: 400 };

/**
 * The caps that apply when the reader asks for the original text.
 *
 * Still a ceiling - an output can be megabytes, and a page that carries
 * one is a page nobody reads - but two orders of magnitude above the
 * digest's, so a whole .npmrc or a whole token check fits in one turn.
 * The page's own budget still applies: raw lifts the per-field cuts,
 * it does not lift the page.
 */
export const RAW_LIMITS: DigestLimits = { textCap: 20000, inputCap: 4000, outputCap: 20000 };

function cut(text: string, cap: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= cap) return trimmed;
  return `${trimmed.slice(0, cap)}… (+${trimmed.length - cap} chars)`;
}

function blocks(blocks: readonly ContentBlock[] | undefined, cap: number): string[] {
  const out: string[] = [];
  for (const block of blocks ?? []) {
    switch (block.type) {
      case "text":
        out.push(cut(block.text, cap));
        break;
      case "file_ref":
        out.push(`@${block.path}`);
        break;
      case "subtask":
        out.push(`[subtask${block.agent ? ` ${block.agent}` : ""}] ${cut(block.prompt, cap)}`);
        break;
      case "image":
        out.push(`[image ${block.mime}]`);
        break;
      case "thinking":
        break;
    }
  }
  return out;
}

function toolLine(call: ToolCallView, limits: DigestLimits): string {
  const input = Object.keys(call.input).length > 0 ? ` ${cut(JSON.stringify(call.input), limits.inputCap)}` : "";
  const head = `[tool] ${call.tool}${input} → ${call.status}`;
  if (!call.output) return head;
  return `${head}\n   ${cut(call.output, limits.outputCap).replaceAll("\n", "\n   ")}`;
}

export function turnBlock(turn: Turn, index: number, limits: DigestLimits = DIGEST_LIMITS): string {
  const lines: string[] = [`— turn ${index + 1}${turn.reverted ? " (reverted)" : ""} —`];
  for (const line of blocks(turn.user, limits.textCap)) lines.push(`[user] ${line}`);
  for (const msg of turn.assistant) {
    for (const line of blocks(msg.content, limits.textCap)) {
      lines.push(`[assistant${msg.partial ? " (in progress)" : ""}${msg.error ? " (error)" : ""}] ${line}`);
    }
    if (msg.error) lines.push(`[assistant error] ${cut(msg.error, limits.outputCap)}`);
  }
  for (const call of turn.tool_calls) lines.push(toolLine(call, limits));
  return lines.join("\n");
}

/** A read window over a session, as model-facing text plus the next page cursor. */
export function digest(
  view: SessionView,
  opts: { from?: number; maxTurns?: number; maxChars?: number; raw?: boolean } = {},
): { text: string; total: number; from: number; to: number; nextFrom: number | null; earlierFrom: number | null } {
  const total = view.turns.length;
  // Raw is the reader asking for the original text rather than a digest
  // of it: the same page, with the per-field cuts lifted.
  const limits = opts.raw === true ? RAW_LIMITS : DIGEST_LIMITS;
  const maxChars = Math.min(Math.max(opts.maxChars ?? 6000, 500), 20000);
  const maxTurns = Math.min(Math.max(opts.maxTurns ?? 15, 1), 50);
  const from = opts.from === undefined ? Math.max(0, total - maxTurns) : Math.max(0, opts.from);
  const header: string[] = [
    `== session ${view.session_id} ==`,
    `title: ${view.title ?? "(untitled)"}`,
    `workspace: ${view.workspace ?? "unknown"}`,
    `backend: ${view.backend}  status: ${view.status}${view.busy ? " (busy)" : ""}`,
  ];
  if (view.parent_session_id) header.push(`parent: ${view.parent_session_id}`);
  if (view.archived) header.push("archived");
  if (view.deleted) header.push("deleted");
  if (view.goal) header.push(`goal: ${cut(view.goal, 300)}${view.goal_met ? " (met)" : ""}`);

  const parts: string[] = [];
  let used = header.join("\n").length + 80;
  let to = from;
  const end = Math.min(total, opts.from === undefined ? total : from + maxTurns);
  for (; to < end; to++) {
    const block = turnBlock(view.turns[to]!, to, limits);
    if (used + block.length > maxChars && to > from) break;
    parts.push(block);
    used += block.length;
  }
  // nextFrom continues toward newer turns; earlierFrom walks back in time —
  // a tail read has only the second, a from-0 read only the first.
  const nextFrom = to < total ? to : null;
  const earlierFrom = from > 0 ? Math.max(0, from - maxTurns) : null;
  // The range, and where it can go next, on one line.
  //
  // The range reads 1-based because that is how the turns below it are
  // labelled (`— turn 41 —`), and `from_turn` is 0-based because that is
  // what it takes. An agent that copied the number it saw into the
  // parameter it was given landed one turn past the one it was looking
  // at — and had no way to tell that was why. So the line carries both:
  // `showing 41-42` is where to look, `from_turn=40` is what to paste.
  //
  // The cursors live here too, next to the range they belong to. A cursor
  // at the foot of a long transcript is a cursor nobody reads, and the
  // range without it says nothing about where the next page is.
  //
  // `truncated at max_chars` says why the page stopped. A range that ends
  // short of the requested turns otherwise looks like the end of the
  // session, and the agent cannot tell "that is all there is" from
  // "that is all that fitted".
  const showing = [
    `turns: ${total} total`,
    `showing ${from + 1}-${to} (1-based)`,
    `from_turn=${from}`,
    to < end ? "truncated at max_chars" : null,
    nextFrom === null ? null : `next_from_turn: ${nextFrom}`,
    earlierFrom === null ? null : `earlier_from_turn: ${earlierFrom}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" | ");
  const body = parts.length > 0 ? parts.join("\n\n") : "(no turns in range)";
  const text = `${header.join("\n")}\n${showing}\n\n${body}`;
  return {
    text,
    total,
    from,
    to,
    nextFrom,
    earlierFrom,
  };
}
