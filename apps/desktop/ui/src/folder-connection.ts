import type { Connection, SessionSource } from "./api";

type FolderRow = { connection_id?: string; source?: SessionSource };

/**
 * The connection a new session in `dir` belongs on.
 *
 * A folder lives on one machine, and the newest session in it says which
 * server that is: sending the session to the new-session default instead
 * opened it on a server where the path does not exist. A folder with no
 * session yet falls back to the default. A folder whose server is not
 * connected answers `offline` with that server's name, because the default
 * would be the wrong machine.
 *
 * `local` is for a worktree: this machine's git made it, so only a server on
 * this machine can open it. No `id` means none is connected.
 */
export function folderConnection<Row extends FolderRow>(opts: {
  dir: string | undefined;
  /** newest first, as the list holds them */
  rows: readonly Row[];
  workspaceOf: (row: Row) => string | undefined;
  connections: readonly Pick<Connection, "id" | "tier">[];
  preferred: string | undefined;
  local?: boolean;
}): { id?: string; offline?: string } {
  const live = new Map(opts.connections.map((conn) => [conn.id, conn]));
  const newest = opts.dir ? opts.rows.find((row) => opts.workspaceOf(row) === opts.dir) : undefined;
  const owner = newest?.connection_id !== undefined && live.has(newest.connection_id) ? newest.connection_id : undefined;
  if (!owner && newest?.source && !newest.source.local && !newest.source.connected) {
    return { offline: newest.source.name };
  }
  const chosen = owner ?? (opts.preferred && live.has(opts.preferred) ? opts.preferred : undefined);
  if (!opts.local) return { id: chosen };
  if (chosen && live.get(chosen)?.tier === "local") return { id: chosen };
  return { id: opts.connections.find((conn) => conn.tier === "local")?.id };
}
