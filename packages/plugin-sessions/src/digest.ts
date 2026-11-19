// SessionView → a compact, model-readable transcript.
//
// The store keeps CASF events; nobody should read those raw. This is the one
// place a session becomes text an agent can scan: a header with the facts the
// projector already decided (status, parent, workspace), then one block per
// turn. Thinking stays out — it is the model's scratch work, not memory — and
// every field is capped so one turn cannot crowd the rest of the page out.
//
// A reader may also ask for one thing rather than a page of everything: a
// query turns the same window into the turns that mention it, which is how a
// long session is read without paging through it.

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

/** How many matches a header will name before it says "and more". */
const MATCHES_NAMED = 12;

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

/** What a read may ask for. */
export interface DigestOptions {
  /** the first turn to include, 0-based */
  from?: number;
  /** turns to include */
  maxTurns?: number;
  /** total size cap */
  maxChars?: number;
  /** the original text rather than a digest of it */
  raw?: boolean;
  /** the turns that mention this, instead of the whole session read through */
  query?: string;
  /** how many turns either side of a match come with it */
  context?: number;
  /** whether every word has to appear (all) or one of them (any) */
  match?: "all" | "any";
}

export interface DigestResult {
  text: string;
  total: number;
  from: number;
  /** the last turn included, exclusive */
  to: number;
  /** the from_turn to pass to continue */
  nextFrom: number | null;
  /** the from_turn to pass to go back */
  earlierFrom: number | null;
  /** the turns that matched a query, 0-based */
  matched: number[];
}

/** The session's own facts, above the page. */
function sessionHeader(view: SessionView): string[] {
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
  return header;
}

/**
 * The text of a turn, whole, for finding it by what it says.
 *
 * The digest cuts a turn down to what fits on a page, so a match has to be
 * found in the text as it was written - or a hit would go missing exactly
 * where the detail is. Thinking counts towards a match but is not shown:
 * the conclusion is what a reader can use, and the reasoning behind it is
 * not theirs.
 */
function searchableText(turn: Turn): string {
  const parts: string[] = [];
  for (const block of turn.user ?? []) {
    if (block.type === "text" || block.type === "thinking") parts.push(block.text);
    else if (block.type === "file_ref") parts.push(block.path);
    else if (block.type === "subtask") parts.push(block.prompt);
  }
  for (const msg of turn.assistant) {
    if (msg.error) parts.push(msg.error);
    for (const block of msg.content ?? []) {
      if (block.type === "text" || block.type === "thinking") parts.push(block.text);
      else if (block.type === "file_ref") parts.push(block.path);
      else if (block.type === "subtask") parts.push(block.prompt);
    }
  }
  for (const call of turn.tool_calls) {
    parts.push(call.tool);
    parts.push(JSON.stringify(call.input ?? {}));
    if (call.output) parts.push(call.output);
  }
  return parts.join("\n");
}

/**
 * A read window over a session, as model-facing text plus the next page cursor.
 */
export function digest(view: SessionView, opts: DigestOptions = {}): DigestResult {
  const query = opts.query?.trim();
  return query ? digestLocate(view, query, opts) : digestWindow(view, opts);
}

function digestWindow(view: SessionView, opts: DigestOptions): DigestResult {
  const total = view.turns.length;
  // Raw is the reader asking for the original text rather than a digest
  // of it: the same page, with the per-field cuts lifted.
  const limits = opts.raw === true ? RAW_LIMITS : DIGEST_LIMITS;
  const maxChars = Math.min(Math.max(opts.maxChars ?? 6000, 500), 20000);
  const maxTurns = Math.min(Math.max(opts.maxTurns ?? 15, 1), 50);
  const from = opts.from === undefined ? Math.max(0, total - maxTurns) : Math.max(0, opts.from);
  const header = sessionHeader(view);

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
  return { text, total, from, to, nextFrom, earlierFrom, matched: [] };
}

/**
 * The turns that mention something, and the context around them.
 *
 * A reader who knows what they are looking for does not want the whole
 * session read back - they want the turn that says it, and the turns
 * around it for context.
 *
 * The cursors point at matches, not at turns: a cursor that walked by
 * turns would land the reader on a page with nothing in it. `next_from_turn`
 * is the next match to read from, `earlier_from_turn` the one that starts
 * the page before this one. Both are 0-based, the way `from_turn` is, so
 * they can be passed back as they are; the matches are named the way a
 * search hit names them, `turn 41 (from_turn=40)`, so the two tools speak
 * one language.
 */
function digestLocate(view: SessionView, query: string, opts: DigestOptions): DigestResult {
  const total = view.turns.length;
  const limits = opts.raw === true ? RAW_LIMITS : DIGEST_LIMITS;
  const maxChars = Math.min(Math.max(opts.maxChars ?? 6000, 500), 20000);
  const maxTurns = Math.min(Math.max(opts.maxTurns ?? 15, 1), 50);
  const context = Math.min(Math.max(opts.context ?? 0, 0), 5);
  const any = opts.match === "any";
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  // A locate read starts at the beginning: the point of it is to find a
  // thing wherever it is, not to read on from somewhere.
  const from = Math.min(Math.max(opts.from ?? 0, 0), total);

  const matches: number[] = [];
  for (let i = 0; i < total; i++) {
    const hay = searchableText(view.turns[i]!).toLowerCase();
    const hit = any ? words.some((w) => hay.includes(w)) : words.every((w) => hay.includes(w));
    if (hit) matches.push(i);
  }

  const candidates = matches.filter((m) => m >= from);
  const selected = candidates.slice(0, maxTurns);

  // The turns to show: every match, and the neighbours it brings with it.
  const wanted = new Set<number>();
  for (const m of selected) {
    for (let t = Math.max(0, m - context); t <= Math.min(total - 1, m + context); t++) wanted.add(t);
  }
  const order = [...wanted].sort((a, b) => a - b);

  const header = sessionHeader(view);
  const parts: string[] = [];
  let used = header.join("\n").length + 80;
  let lastRendered = -1;
  for (const index of order) {
    const block = turnBlock(view.turns[index]!, index, limits);
    if (used + block.length > maxChars && parts.length > 0) break;
    parts.push(block);
    used += block.length;
    lastRendered = index;
  }

  const rendered = selected.filter((m) => m <= lastRendered);
  const lastShown = rendered.length > 0 ? rendered[rendered.length - 1]! : -1;
  const firstShown = rendered.length > 0 ? rendered[0]! : -1;
  // The next cursor is the next match, not the next turn: paging by turn
  // would land the reader on a page with nothing in it.
  const nextFrom = candidates.find((m) => m > lastShown) ?? null;
  // The back cursor starts the page before this one, which is a whole page
  // of matches earlier — not the match right before this page, which
  // would re-show what is already on screen.
  const before = matches.filter((m) => m < firstShown);
  const earlierFrom =
    before.length > maxTurns ? (before[before.length - maxTurns] ?? null) : (before[0] ?? null);

  // The matches are named the way a search hit names them, so a reader who
  // searched and then read is reading one language, not two.
  const named = matches.slice(0, MATCHES_NAMED).map((m) => `turn ${m + 1} (from_turn=${m})`);
  const rest = matches.length - named.length;
  const shown =
    rendered.length > 0
      ? `showing ${rendered.map((m) => `turn ${m + 1}`).join(", ")} (1-based)`
      : "showing no matching turn";
  const showing = [
    `query "${query}": ${rendered.length} of ${candidates.length} match${candidates.length === 1 ? "" : "es"}`,
    shown,
    `matching: ${named.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`,
    nextFrom === null ? null : `next_from_turn: ${nextFrom}`,
    earlierFrom === null ? null : `earlier_from_turn: ${earlierFrom}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" | ");
  const body = parts.length > 0 ? parts.join("\n\n") : "(no turn matched)";
  const text = `${header.join("\n")}\n${showing}\n\n${body}`;
  return { text, total, from, to: lastRendered + 1, nextFrom, earlierFrom, matched: rendered };
}
