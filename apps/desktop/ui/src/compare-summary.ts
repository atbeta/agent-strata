import { fmtDuration, fmtUsd, folderLabel, type SessionRow } from "./api";
import { num, stamp, t } from "./i18n";
import { displayTitle } from "./session-title";

/** A title when the row is loaded, otherwise a short id so a missing session is still nameable. */
export function compareSessionTitle(row: SessionRow | undefined, id: string): string {
  if (!row) return id.length > 12 ? `${id.slice(0, 8)}…` : id;
  return displayTitle(row.title ?? row.summary.title) ?? t("common.untitled");
}

/** Folder and clock time, the two things that tell two similarly named sessions apart. */
export function compareSessionDetail(row: SessionRow | undefined): string {
  if (!row) return "";
  const folder = folderLabel(row.workspace ?? row.summary.workspace);
  const when = stamp(row.summary.last_ts);
  return folder ? `${folder} · ${when}` : when;
}

export function findSession(sessions: SessionRow[], id: string): SessionRow | undefined {
  return sessions.find((s) => s.summary.session_id === id);
}

/**
 * The first turn whose prompts are not the same text, including a side that
 * has already run out. `-1` when every paired turn still matches.
 */
export function firstDivergentTurn(pairs: { same_prompt: boolean }[]): number {
  return pairs.findIndex((p) => !p.same_prompt);
}

/**
 * A − B across every turn, or null when any turn is missing a duration.
 * A partial sum would read as the whole session.
 */
export function pairedDurationDelta(
  pairs: { delta: { duration_ms: number | null } }[],
): number | null {
  if (pairs.length === 0) return null;
  let sum = 0;
  for (const pair of pairs) {
    if (pair.delta.duration_ms == null) return null;
    sum += pair.delta.duration_ms;
  }
  return sum;
}

export interface UsageDelta {
  /** A − B. Positive means A cost more, used more tokens, or took longer. */
  cost: number;
  tokens: number;
  /** Null when the two sessions cannot be timed against each other. */
  durationMs: number | null;
}

const costMatters = (n: number) => Math.abs(n) >= 0.00005;
const timeMatters = (n: number) => Math.abs(n) >= 1000;

function joinClauses(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  const head = parts.slice(0, -1).join(t("compare.delta.join"));
  return `${head}${t("compare.delta.last")}${parts[parts.length - 1]}`;
}

/** One sentence that says which side spent more, so the sign is not left to guess. */
export function usageDeltaSentence(delta: UsageDelta): string {
  const parts: string[] = [];
  if (costMatters(delta.cost)) {
    parts.push(
      t(delta.cost > 0 ? "compare.delta.costMore" : "compare.delta.costLess", {
        amount: fmtUsd(Math.abs(delta.cost)),
      }),
    );
  }
  if (delta.tokens !== 0) {
    parts.push(
      t(delta.tokens > 0 ? "compare.delta.tokensMore" : "compare.delta.tokensLess", {
        n: num(Math.abs(delta.tokens)),
      }),
    );
  }
  if (delta.durationMs != null && timeMatters(delta.durationMs)) {
    parts.push(
      t(delta.durationMs > 0 ? "compare.delta.timeSlower" : "compare.delta.timeFaster", {
        time: fmtDuration(Math.abs(delta.durationMs)),
      }),
    );
  }
  if (parts.length === 0) {
    return t(delta.durationMs == null ? "compare.delta.evenNoTime" : "compare.delta.even");
  }
  return t("compare.delta.sentence", { detail: joinClauses(parts) });
}
