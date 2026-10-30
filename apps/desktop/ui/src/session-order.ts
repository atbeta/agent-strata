export type SessionOrderRow = {
  summary: {
    session_id: string;
    last_ts: string;
  };
  busy?: boolean;
};

export function rememberBusySince(
  busySince: Map<string, string>,
  rows: readonly SessionOrderRow[],
): void {
  for (const row of rows) {
    const id = row.summary.session_id;
    if (row.busy !== true) {
      busySince.delete(id);
      continue;
    }
    if (!busySince.has(id)) busySince.set(id, row.summary.last_ts);
  }
}

function compareDesc(a: string, b: string): number {
  return a === b ? 0 : a < b ? 1 : -1;
}

function compareAsc(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

export function compareProjectRows(
  a: SessionOrderRow,
  b: SessionOrderRow,
  busySince: ReadonlyMap<string, string>,
): number {
  const aBusy = a.busy === true;
  const bBusy = b.busy === true;
  if (aBusy !== bBusy) return aBusy ? -1 : 1;
  const aId = a.summary.session_id;
  const bId = b.summary.session_id;
  const aTs = aBusy ? busySince.get(aId) ?? a.summary.last_ts : a.summary.last_ts;
  const bTs = bBusy ? busySince.get(bId) ?? b.summary.last_ts : b.summary.last_ts;
  return compareDesc(aTs, bTs) || compareAsc(aId, bId);
}
