import type { ContentBlock, ToolCallView, Turn } from "./api";

/**
 * Where the request's input tokens went, as four shares of one bar.
 *
 * This is the OpenCode desktop's own approximation, reproduced against the
 * project's transcript instead of its live message store: count characters in
 * the user, assistant and tool text, divide by four, and normalise the result
 * to the last assistant message's `tokens.input`. It is an estimate on both
 * ends — character counts are not token counts, and `input` is only the
 * uncached part of a request — which is why the panel calls it an estimate and
 * never shows these numbers as the exact context total.
 *
 * `other` is what the three measured buckets cannot explain: the system
 * prompt, tool definitions, and provider overhead. When the estimates already
 * exceed `input` they are scaled down instead, and `other` keeps only the
 * rounding remainder; the desktop's note says the same thing. Our transcript
 * does not keep the assembled request, so a large `other` would mean the
 * request contains more than the conversation — not that something failed.
 */
export type ContextBreakdownKey = "user" | "assistant" | "tool" | "other";

export interface ContextBreakdownSegment {
  key: ContextBreakdownKey;
  /** Estimated tokens this bucket contributed to `input`. */
  tokens: number;
  /** Share of `input`, rounded to one decimal. */
  percent: number;
  /** Unrounded share, for the bar's width. */
  width: number;
}

const KEY_ORDER: ContextBreakdownKey[] = ["user", "assistant", "tool", "other"];

/** The desktop's ratio. Four characters per token is the usual English rule of
 *  thumb; it is wrong for CJK and for JSON in different directions, which is
 *  why the result is presented as a shape rather than a measurement. */
const estimateTokens = (chars: number) => Math.ceil(chars / 4);

function blockChars(blocks: ContentBlock[] | undefined): number {
  let chars = 0;
  for (const block of blocks ?? []) {
    if (block.type === "text" || block.type === "thinking") chars += block.text.length;
    // A file reference stands in for the file's contents in the request, which
    // our log never kept. Its path is a floor, not a guess at the content.
    else if (block.type === "file_ref") chars += block.path.length;
    // An image is billed by the provider's own image accounting, not by the
    // length of its base64 payload.
  }
  return chars;
}

function toolChars(call: ToolCallView): number {
  let input = 0;
  try {
    input = JSON.stringify(call.input ?? {}).length;
  } catch {
    // A value that cannot be serialised did not travel as text either.
  }
  return input + (call.output?.length ?? 0);
}

export function estimateSessionContextBreakdown(turns: Turn[], input: number): ContextBreakdownSegment[] {
  if (!Number.isFinite(input) || input <= 0) return [];

  // The projector marks the turn a compaction divider follows. Everything
  // before it has been replaced by the summary, so counting it would describe
  // a request the backend no longer sends.
  let active = turns;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i]?.compaction) {
      active = turns.slice(i + 1);
      break;
    }
  }

  const chars = { user: 0, assistant: 0, tool: 0 };
  for (const turn of active) {
    chars.user += blockChars(turn.user);
    for (const message of turn.assistant ?? []) chars.assistant += blockChars(message.content);
    for (const call of turn.tool_calls ?? []) chars.tool += toolChars(call);
  }

  const estimated = {
    user: estimateTokens(chars.user),
    assistant: estimateTokens(chars.assistant),
    tool: estimateTokens(chars.tool),
  };
  const measured = estimated.user + estimated.assistant + estimated.tool;

  let tokens: Record<ContextBreakdownKey, number>;
  if (measured <= input) {
    tokens = { ...estimated, other: input - measured };
  } else {
    const scale = input / measured;
    const user = Math.floor(estimated.user * scale);
    const assistant = Math.floor(estimated.assistant * scale);
    const tool = Math.floor(estimated.tool * scale);
    tokens = { user, assistant, tool, other: Math.max(0, input - user - assistant - tool) };
  }

  return KEY_ORDER.map((key) => ({ key, tokens: tokens[key] }))
    .filter((segment) => segment.tokens > 0)
    .map((segment) => ({
      ...segment,
      percent: Math.round((segment.tokens / input) * 1000) / 10,
      // Three decimals are plenty for a CSS width and keep the arithmetic from
      // putting 7.000000000000001 into a style attribute.
      width: Math.round((segment.tokens / input) * 100000) / 1000,
    }));
}
