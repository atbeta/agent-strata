import type { ContentBlock, ToolCallView, Turn } from "./api";

export type ContextPartKey = "system" | "user" | "assistant" | "tool" | "other";

export interface ContextPart {
  key: ContextPartKey;
  tokens: number;
  /** Share of the input the backend reported, rounded to one decimal. */
  percent: number;
  /** Unrounded share, for a bar's width. */
  width: number;
}

/**
 * A rough token count for content the backend does not break down.
 *
 * Four characters per token is the estimate OpenCode's own desktop uses. It is
 * wrong for CJK (closer to one token per character) and for code, and the card
 * says so: every number here is an estimate, and the total is not.
 */
const tokensOf = (chars: number) => Math.ceil(chars / 4);

function userChars(blocks: readonly ContentBlock[] | undefined): number {
  if (!blocks) return 0;
  let chars = 0;
  for (const block of blocks) {
    if (block.type === "text") chars += block.text.length;
    else if (block.type === "file_ref") chars += block.path.length;
  }
  return chars;
}

function assistantChars(turn: Turn): { assistant: number; tool: number } {
  let assistant = 0;
  for (const message of turn.assistant) {
    for (const block of message.content) {
      if (block.type === "text" || block.type === "thinking") assistant += block.text.length;
    }
  }
  let tool = 0;
  for (const call of turn.tool_calls) tool += toolChars(call);
  return { assistant, tool };
}

/**
 * What a tool call puts in the window.
 *
 * The argument object is counted by its keys — the schema a call names is the
 * bulk of it, and serialising every value would count the contents of a file
 * the call merely points at. The result is counted by its text.
 */
function toolChars(call: ToolCallView): number {
  return Object.keys(call.input).length * 16 + (call.output?.length ?? 0);
}

interface Counts {
  system: number;
  user: number;
  assistant: number;
  tool: number;
}

function segments(counts: Counts, input: number): ContextPart[] {
  const tokens = {
    system: tokensOf(counts.system),
    user: tokensOf(counts.user),
    assistant: tokensOf(counts.assistant),
    tool: tokensOf(counts.tool),
  };
  const estimated = tokens.system + tokens.user + tokens.assistant + tokens.tool;
  // An estimate larger than the backend's own count would draw a bar wider
  // than the window it sits in. Scale every category down and let "other"
  // absorb what is left; the backend's number is the one that is true.
  const scale = estimated > input && estimated > 0 ? input / estimated : 1;
  const scaled = {
    system: Math.floor(tokens.system * scale),
    user: Math.floor(tokens.user * scale),
    assistant: Math.floor(tokens.assistant * scale),
    tool: Math.floor(tokens.tool * scale),
  };
  const used = scaled.system + scaled.user + scaled.assistant + scaled.tool;
  const other = Math.max(0, input - used);
  return (Object.entries({ ...scaled, other }) as [ContextPartKey, number][])
    .filter(([, value]) => value > 0)
    .map(([key, value]) => ({
      key,
      tokens: value,
      percent: Math.round((value / input) * 1000) / 10,
      width: Math.round((value / input) * 100000) / 1000,
    }));
}

/**
 * What the last request's input was made of.
 *
 * `input` is the backend's non-cached input count, which is what OpenCode's own
 * desktop divides this estimate by. `system` stays empty here: this app never
 * receives the system prompt, so its share lands in "other" — the same place
 * tool definitions and the estimate's own error go.
 */
export function contextBreakdown(
  turns: readonly Turn[],
  input: number,
  systemPrompt?: string,
): ContextPart[] {
  if (!Number.isFinite(input) || input <= 0) return [];
  const counts: Counts = { system: systemPrompt?.length ?? 0, user: 0, assistant: 0, tool: 0 };
  for (const turn of turns) {
    counts.user += userChars(turn.user);
    const next = assistantChars(turn);
    counts.assistant += next.assistant;
    counts.tool += next.tool;
  }
  return segments(counts, input);
}
