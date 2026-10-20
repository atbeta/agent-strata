import type { SessionContext } from "./prompt-memory";

export type RequestPartKey = "cache_read" | "cache_write" | "input" | "output" | "reasoning";

export interface RequestPart {
  key: RequestPartKey;
  tokens: number;
  /** Share of `total`, rounded to one decimal. */
  percent: number;
  /** Unrounded share, for the bar's width. */
  width: number;
}

const PART_ORDER: RequestPartKey[] = ["cache_read", "cache_write", "input", "output", "reasoning"];

/** The reported request split into shares of `total`, in display order:
 *  what the cache served first, then what the call actually did. */
export function requestParts(usage: SessionContext["usage"], total: number): RequestPart[] {
  if (!Number.isFinite(total) || total <= 0) return [];
  return PART_ORDER.map((key) => ({ key, tokens: usage[key] }))
    .filter((part) => part.tokens > 0)
    .map((part) => ({
      ...part,
      percent: Math.round((part.tokens / total) * 1000) / 10,
      // Three decimals are plenty for a CSS width and keep the arithmetic
      // from putting 7.000000000000001 into a style attribute.
      width: Math.round((part.tokens / total) * 100000) / 1000,
    }));
}
