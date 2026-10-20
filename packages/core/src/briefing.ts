import { DEFAULT_SECRET_PATTERNS, type ContentBlock } from "@agent-strata/schema";
import type { SessionView, Turn } from "@agent-strata/projector";

/** A briefing is a prompt, not a transcript. Past this it stops being one. */
export const BRIEFING_MAX_CHARS = 8_000;

const TEXT_MAX = 500;
const GOAL_MAX = 1_000;
const TURNS_MAX = 6;
const FILES_MAX = 40;
const TOOLS_MAX = 12;

const REDACTED = "[redacted]";

function scrub(text: string): string {
  let out = text;
  for (const pattern of DEFAULT_SECRET_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    out = out.replace(new RegExp(pattern.source, flags), REDACTED);
  }
  return out;
}

function clip(text: string, max: number): string {
  const trimmed = scrub(text).trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function spoken(blocks: ContentBlock[] | undefined): string {
  if (!blocks) return "";
  return blocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
}

function assistantText(turn: Turn): string {
  return turn.assistant
    .filter((message) => !message.partial)
    .map((message) => spoken(message.content))
    .filter(Boolean)
    .join("\n\n");
}

function toolLine(turn: Turn): string {
  const calls = turn.tool_calls.slice(0, TOOLS_MAX).map((call) => `${call.tool} ${call.status}`);
  const extra = turn.tool_calls.length - calls.length;
  const line = extra > 0 ? `${calls.join(", ")}, +${extra} more` : calls.join(", ");
  return line;
}

interface TurnNote {
  user: string;
  assistant: string;
  tools: string;
}

function noteOf(turn: Turn): TurnNote | undefined {
  const user = clip(spoken(turn.user), TEXT_MAX);
  const assistant = clip(assistantText(turn), TEXT_MAX);
  const tools = toolLine(turn);
  if (!user && !assistant && !tools) return undefined;
  return { user, assistant, tools };
}

function formatTurn(note: TurnNote): string[] {
  const lines: string[] = [];
  if (note.user) lines.push(`User: ${note.user}`);
  if (note.assistant) lines.push(`Assistant: ${note.assistant}`);
  if (note.tools) lines.push(`tools: ${note.tools}`);
  return lines;
}

/**
 * A bounded briefing of one session, for opening a new session on another backend.
 *
 * The other backend receives this as the first prompt. It names the goal, the
 * files, the plan still open, and the latest things said. Tool arguments,
 * tool output, diffs and thoughts stay behind: they are the part that does
 * not fit in a prompt, and the part most likely to carry a secret.
 */
export function sessionBriefing(view: SessionView): string {
  const lines: string[] = [
    "Continue this work in a new session. This briefing summarizes another agent's session. That session stays where it was. You do not share its tools, its permissions, or its conversation.",
    "",
    "Source",
    `backend: ${view.backend}`,
  ];
  if (view.title) lines.push(`title: ${clip(view.title, 200)}`);
  if (view.workspace && view.workspace !== "unknown" && view.workspace !== "no workspace") {
    lines.push(`workspace: ${view.workspace}`);
  }
  lines.push(`session: ${view.session_id}`);

  if (view.goal) {
    lines.push("", "Goal", clip(view.goal, GOAL_MAX));
  }

  if (view.files_changed.length > 0) {
    lines.push("", "Files changed");
    for (const file of view.files_changed.slice(0, FILES_MAX)) {
      lines.push(`${file.change} ${file.path}`);
    }
    const more = view.files_changed.length - FILES_MAX;
    if (more > 0) lines.push(`+${more} more files`);
  }

  const plan = view.plan ?? [];
  const open = plan.filter((entry) => entry.status !== "completed");
  const completed = plan.length - open.length;
  if (open.length > 0 || completed > 0) {
    lines.push("", "Open plan");
    for (const entry of open) lines.push(`${entry.status} ${clip(entry.content, TEXT_MAX)}`);
    if (completed > 0) {
      lines.push(`${completed} plan ${completed === 1 ? "entry" : "entries"} already completed`);
    }
  }

  const waiting: string[] = [];
  for (const pending of view.pending_questions) {
    for (const question of pending.questions) waiting.push(`question: ${clip(question.question, TEXT_MAX)}`);
  }
  for (const turn of view.turns) {
    if (turn.reverted) continue;
    for (const call of turn.tool_calls) {
      if (call.permission && call.permission.decision === undefined) waiting.push(`permission: ${call.tool}`);
    }
  }
  if (view.pending_permissions.some((permission) => permission.decision === undefined)) {
    waiting.push("permission: waiting");
  }
  if (waiting.length > 0) lines.push("", "Still waiting", ...waiting);

  const active = view.turns.filter((turn) => !turn.reverted);
  const notes = active.flatMap((turn) => {
    const note = noteOf(turn);
    return note ? [note] : [];
  });
  const kept = notes.slice(-TURNS_MAX);
  let omitted = notes.length - kept.length;
  const head = lines.join("\n");

  const render = (chosen: TurnNote[], dropped: number): string => {
    const body = [...(head ? [head] : [])];
    if (chosen.length > 0 || dropped > 0) {
      body.push("", "Recent turns");
      if (dropped > 0) body.push("Earlier turns are not included.");
      for (const note of chosen) body.push(...formatTurn(note), "");
    }
    return scrub(body.join("\n").trimEnd() + "\n");
  };

  let chosen = kept;
  let text = render(chosen, omitted);
  while (text.length > BRIEFING_MAX_CHARS && chosen.length > 1) {
    chosen = chosen.slice(1);
    omitted += 1;
    text = render(chosen, omitted);
  }
  if (text.length > BRIEFING_MAX_CHARS) {
    text = `${text.slice(0, BRIEFING_MAX_CHARS - 1).trimEnd()}…\n`;
  }
  return text;
}
