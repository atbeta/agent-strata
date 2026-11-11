import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { SessionView } from "@agent-strata/projector";
import type { Store } from "@agent-strata/store";
import { availableBackupName, maintenanceDirs, safeName } from "./maintenance";
import type { ViewCache } from "./views";

export async function maintenanceRoute(
  req: Request,
  path: string,
  deps: {
    store: Store;
    dirs: ReturnType<typeof maintenanceDirs>;
    snapshot(): unknown;
    backupBefore(why: string): string | undefined;
    sessionView(sessionId: string): SessionView;
    views: ViewCache;
    broadcast(payload: unknown): void;
  },
): Promise<Response | undefined> {
  if (path === "/maintenance" && req.method === "GET") {
    return Response.json(deps.snapshot());
  }

  if (path === "/maintenance/check" && req.method === "POST") {
    return Response.json({ results: deps.store.integrityCheck() });
  }

  if (path === "/maintenance/optimize" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { vacuum?: unknown } | null;
    const backup = body?.vacuum === true ? deps.backupBefore("vacuum") : undefined;
    deps.store.optimize();
    if (body?.vacuum === true) deps.store.vacuum();
    return Response.json({ ...(deps.snapshot() as object), backup });
  }

  if (path === "/maintenance/backup" && req.method === "POST") {
    mkdirSync(deps.dirs.backupDir, { recursive: true });
    const name = availableBackupName(deps.dirs.dir);
    deps.store.backupTo(join(deps.dirs.backupDir, name));
    return Response.json(deps.snapshot());
  }

  const removeBackup = path.match(/^\/maintenance\/backups\/([^/]+)$/);
  if (removeBackup && req.method === "DELETE") {
    const name = decodeURIComponent(removeBackup[1]!);
    if (!safeName(name)) return Response.json({ error: "invalid backup name" }, { status: 400 });
    try {
      unlinkSync(join(deps.dirs.backupDir, name));
    } catch {
      return Response.json({ error: "backup not found" }, { status: 404 });
    }
    return Response.json(deps.snapshot());
  }

  const removeLegacy = path.match(/^\/maintenance\/legacy\/([^/]+)$/);
  if (removeLegacy && req.method === "DELETE") {
    const name = decodeURIComponent(removeLegacy[1]!);
    if (!safeName(name) || !name.includes(".bak")) {
      return Response.json({ error: "invalid snapshot name" }, { status: 400 });
    }
    try {
      unlinkSync(join(deps.dirs.dir, name));
    } catch {
      return Response.json({ error: "snapshot not found" }, { status: 404 });
    }
    return Response.json(deps.snapshot());
  }

  if (path === "/maintenance/clean" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as {
      mode?: unknown;
      session_ids?: unknown;
      older_than_days?: unknown;
      archived_only?: unknown;
      apply?: unknown;
    } | null;
    if (body?.mode !== "rebuildable") {
      return Response.json({ error: "mode must be rebuildable" }, { status: 400 });
    }
    const mode = "rebuildable" as const;
    let ids: string[] = [];
    if (Array.isArray(body.session_ids)) {
      ids = body.session_ids.filter((id): id is string => typeof id === "string" && id.length > 0);
    } else {
      const days = Number(body.older_than_days);
      if (!Number.isFinite(days) || days <= 0) {
        return Response.json({ error: "session_ids or older_than_days is required" }, { status: 400 });
      }
      const cutoff = Date.now() - days * 86_400_000;
      const summaries = deps.store.listSessions();
      ids = summaries
        .filter((summary) => {
          const at = new Date(summary.last_ts).getTime();
          return Number.isFinite(at) && at < cutoff;
        })
        .map((summary) => summary.session_id);
      if (body.archived_only === true) {
        ids = ids.filter((id) => {
          try {
            return deps.sessionView(id).archived === true;
          } catch {
            return false;
          }
        });
      }
    }
    ids = [...new Set(ids)].slice(0, 1000);
    const counts = new Map(deps.store.classCounts(ids).map((row) => [row.session_id, row]));
    const summaries = new Map(
      deps.store.listSessions().map((summary) => [summary.session_id, summary]),
    );
    const targets = ids
      .map((id) => {
        const cls = counts.get(id);
        const row = summaries.get(id);
        return {
          session_id: id,
          title: row?.title ?? null,
          workspace: row?.workspace ?? null,
          last_ts: row?.last_ts ?? null,
          rebuildable: cls?.rebuildable ?? 0,
          local: cls?.local ?? 0,
          rebuildable_bytes: cls?.rebuildable_bytes ?? 0,
          local_bytes: cls?.local_bytes ?? 0,
        };
      })
      .filter((row) => row.rebuildable > 0);
    const totals = targets.reduce(
      (sum, row) => ({
        sessions: sum.sessions + 1,
        rebuildable: sum.rebuildable + row.rebuildable,
        local: sum.local + row.local,
        rebuildable_bytes: sum.rebuildable_bytes + row.rebuildable_bytes,
        local_bytes: sum.local_bytes + row.local_bytes,
      }),
      { sessions: 0, rebuildable: 0, local: 0, rebuildable_bytes: 0, local_bytes: 0 },
    );
    if (body.apply !== true) return Response.json({ mode, applied: false, targets, totals });
    const backup = deps.backupBefore("clean");
    const deleted = deps.store.deleteRebuildable(ids);
    for (const id of ids) deps.views.drop(id);
    deps.broadcast({ type: "maintenance.applied", mode, sessions: ids });
    return Response.json({ mode, applied: true, deleted, targets, totals, backup });
  }

  return undefined;
}
