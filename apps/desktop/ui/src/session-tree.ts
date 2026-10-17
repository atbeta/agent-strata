/**
 * The sessions a session opened, at any depth.
 *
 * A subagent's row is not in the sidebar, but what it is waiting on still
 * stops the conversation the reader is in: the run the reader started is the
 * run that cannot move. So the reader's session has to see its descendants'
 * prompts, and this is the one place that works out which sessions those are.
 *
 * The list is the only source: parent links are read from it, and a link that
 * points at itself, at a session that is not in the list, or round a cycle is
 * dropped rather than followed.
 */
export function descendantSessions(
  rows: readonly { summary: { session_id: string }; parent?: string | null }[],
  id: string,
): Set<string> {
  const children = new Map<string, string[]>();
  const known = new Set<string>();
  for (const row of rows) known.add(row.summary.session_id);
  for (const row of rows) {
    const parent = row.parent ?? undefined;
    const child = row.summary.session_id;
    if (!parent || parent === child || !known.has(parent)) continue;
    const list = children.get(parent);
    if (list) list.push(child);
    else children.set(parent, [child]);
  }
  const out = new Set<string>();
  const queue = [...(children.get(id) ?? [])];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (next === id || out.has(next)) continue;
    out.add(next);
    queue.push(...(children.get(next) ?? []));
  }
  return out;
}
