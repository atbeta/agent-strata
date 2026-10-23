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

export interface ChildBoardRow {
  summary: { session_id: string; last_ts?: string };
  parent?: string | null;
  deleted?: boolean;
  busy?: boolean;
  needs_input?: boolean;
  status?: string;
}

/**
 * The sessions this one opened directly, in the order a board should show them.
 *
 * Waiting outranks running, and running outranks a session that has already
 * stopped. Deleted rows are gone. A row that names itself is not its own child.
 * Deeper descendants stay on their own parent's board.
 */
export function childBoardRows<T extends ChildBoardRow>(rows: readonly T[], id: string): T[] {
  const rank = (row: T) => (row.needs_input ? 0 : row.busy ? 1 : row.status === "error" ? 2 : 3);
  return rows
    .filter((row) => row.parent === id && row.summary.session_id !== id && row.deleted !== true)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        (b.summary.last_ts ?? "").localeCompare(a.summary.last_ts ?? ""),
    );
}

/**
 * Open the fold on arrival when a child is waiting on the reader.
 *
 * A quiet list stays shut. Several finished children under the header are a
 * count, and the titles are a click away; a child that cannot move without
 * the reader is the case the fold exists to put on screen.
 */
export function childBoardStartsOpen(rows: readonly { needs_input?: boolean }[]): boolean {
  return rows.some((row) => row.needs_input === true);
}

export interface ChildBoardFold {
  waiting: number;
  running: number;
  /**
   * The child a closed fold names. Waiting outranks running. A list where
   * nobody is mid-work names nobody — the count is the whole line.
   */
  previewId?: string;
}

/** What the closed fold can say without spreading every title across the header. */
export function childBoardFold<T extends { summary: { session_id: string }; needs_input?: boolean; busy?: boolean }>(
  rows: readonly T[],
): ChildBoardFold {
  const waitingRows = rows.filter((row) => row.needs_input);
  const runningRows = rows.filter((row) => row.busy && !row.needs_input);
  const preview = waitingRows[0] ?? runningRows[0];
  return {
    waiting: waitingRows.length,
    running: runningRows.length,
    previewId: preview?.summary.session_id,
  };
}
