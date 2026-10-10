import { parsePatch, type DiffRow } from "./patch";

export type SplitCell = {
  kind: "add" | "del" | "ctx" | "empty";
  text: string;
  line?: number;
};

export type SplitRow =
  | { kind: "hunk"; text: string }
  | { kind: "pair"; left: SplitCell; right: SplitCell };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A unified diff as two columns. A removed line sits beside the line that replaced it. */
export function splitPatch(patch: string): SplitRow[] {
  const rows = parsePatch(patch);
  const out: SplitRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let dels: SplitCell[] = [];
  let adds: SplitCell[] = [];

  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      out.push({
        kind: "pair",
        left: dels[i] ?? { kind: "empty", text: "" },
        right: adds[i] ?? { kind: "empty", text: "" },
      });
    }
    dels = [];
    adds = [];
  };

  const take = (row: DiffRow) => {
    if (row.kind === "hunk") {
      flush();
      const m = HUNK.exec(row.text);
      oldLine = m ? Number(m[1]) : 0;
      newLine = m ? Number(m[2]) : 0;
      out.push({ kind: "hunk", text: row.text });
      return;
    }
    if (row.kind === "del") {
      if (adds.length) flush();
      dels.push({ kind: "del", text: row.text, line: oldLine });
      oldLine += 1;
      return;
    }
    if (row.kind === "add") {
      adds.push({ kind: "add", text: row.text, line: newLine });
      newLine += 1;
      return;
    }
    flush();
    out.push({
      kind: "pair",
      left: { kind: "ctx", text: row.text, line: oldLine },
      right: { kind: "ctx", text: row.text, line: newLine },
    });
    oldLine += 1;
    newLine += 1;
  };

  for (const row of rows) take(row);
  flush();
  return out;
}
