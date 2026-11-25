import { describe, expect, test } from "bun:test";
import { folderConnection } from "./folder-connection";
import type { SessionSource } from "./api";

type Row = { dir: string; connection_id?: string; source?: SessionSource };

const engine = { id: "eng", tier: "local" as const };
const remote = { id: "rem", tier: "remote" as const };

function pick(rows: Row[], opts: { dir?: string; preferred?: string; local?: boolean; live?: (typeof engine | typeof remote)[] } = {}) {
  return folderConnection({
    dir: "dir" in opts ? opts.dir : "/repo",
    rows,
    workspaceOf: (row) => row.dir,
    connections: opts.live ?? [engine, remote],
    preferred: opts.preferred,
    local: opts.local,
  });
}

describe("folderConnection", () => {
  test("a folder's newest session names its server, over the new-session default", () => {
    const rows = [
      { dir: "/elsewhere", connection_id: "eng" },
      { dir: "/repo", connection_id: "rem" },
      { dir: "/repo", connection_id: "eng" },
    ];
    expect(pick(rows, { preferred: "eng" })).toEqual({ id: "rem" });
  });

  test("a folder with no session, or no folder at all, takes the default", () => {
    expect(pick([], { preferred: "rem" })).toEqual({ id: "rem" });
    expect(pick([{ dir: "/repo", connection_id: "eng" }], { dir: undefined, preferred: "rem" })).toEqual({ id: "rem" });
  });

  test("a folder whose server is not connected is refused by name", () => {
    const rows = [{ dir: "/repo", source: { color: 0, name: "家里 101", connected: false } }];
    expect(pick(rows, { preferred: "eng" })).toEqual({ offline: "家里 101" });
  });

  test("a worktree only opens on this machine", () => {
    expect(pick([{ dir: "/repo", connection_id: "eng" }], { local: true, preferred: "rem" })).toEqual({ id: "eng" });
    expect(pick([], { local: true, preferred: "rem" })).toEqual({ id: "eng" });
    expect(pick([], { local: true, preferred: "rem", live: [remote] })).toEqual({ id: undefined });
  });

  test("a worktree is not refused because the folder's remote server is away", () => {
    const rows = [{ dir: "/repo", source: { color: 0, name: "家里 101", connected: false } }];
    expect(pick(rows, { local: true, preferred: "rem" })).toEqual({ id: "eng" });
  });
});
