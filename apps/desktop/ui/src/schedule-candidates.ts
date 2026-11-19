import type { ScheduleCandidate } from "./api";

export function filterScheduleCandidates(
  candidates: readonly ScheduleCandidate[],
  query: string,
): ScheduleCandidate[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...candidates];
  return candidates.filter((candidate) =>
    `${candidate.title ?? ""}\n${candidate.session_id}`.toLocaleLowerCase().includes(needle),
  );
}
