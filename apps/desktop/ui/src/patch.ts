export type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "add"; text: string }
  | { kind: "del"; text: string }
  | { kind: "ctx"; text: string };

/**
 * Split a unified diff into rows a reader can look at.
 *
 * Everything before the first `@@` is metadata — the `Index:` line, the `===`
 * ruler, and the `---`/`+++` file headers — and is dropped rather than shown,
 * because those same prefixes are also how added and removed lines start. The
 * header is where the confusion comes from, not the hunk body.
 */
export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (!inHunk) continue;
    // the split leaves a trailing "" for the patch's own final newline
    if (line === "") continue;
    // "\ No newline at end of file" is a note about the previous line
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1) });
    else rows.push({ kind: "ctx", text: line.slice(1) });
  }
  return rows;
}