import { apiFetch } from "./api";
import { t } from "./i18n";

export interface ClassStats {
  events: number;
  bytes: number;
}

export interface StoreStats {
  sessions: number;
  events: number;
  /** Sum of event bodies, not the size of the file on disk. */
  bytes: number;
  fts: number;
  oldest: string | null;
  newest: string | null;
  rebuildable: ClassStats;
  local: ClassStats;
}

export interface MaintenanceFile {
  name: string;
  path: string;
  bytes: number;
  modified_at: number;
}

export interface MaintenanceSnapshot {
  db: {
    path: string | null;
    bytes: number;
    wal_bytes: number;
    shm_bytes: number;
    stats: StoreStats;
  };
  backups: MaintenanceFile[];
  legacy: MaintenanceFile[];
}

export interface CleanTarget {
  session_id: string;
  title: string | null;
  workspace: string | null;
  last_ts: string | null;
  rebuildable: number;
  local: number;
  rebuildable_bytes: number;
  local_bytes: number;
}

export interface CleanTotals {
  sessions: number;
  rebuildable: number;
  local: number;
  rebuildable_bytes: number;
  local_bytes: number;
}

export interface CleanResult {
  mode: "rebuildable";
  applied: boolean;
  deleted?: number;
  targets: CleanTarget[];
  totals: CleanTotals;
  /** Name of the copy taken just before the delete, when one was made. */
  backup?: string;
}

/**
 * The snapshot an optimize or a vacuum answers with.
 *
 * A vacuum takes a backup first — it rewrites the whole file, and it is the
 * operation a reader reaches for when the disk is nearly full. The name comes
 * back so the reader can be told one exists instead of having to guess.
 */
export interface OptimizeResult extends MaintenanceSnapshot {
  backup?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? t("api.err.service", { status: res.status }));
  }
  return (await res.json()) as T;
}

export function readMaintenance(): Promise<MaintenanceSnapshot> {
  return request<MaintenanceSnapshot>("/maintenance");
}

export function checkMaintenance(): Promise<{ results: string[] }> {
  return request<{ results: string[] }>("/maintenance/check", { method: "POST" });
}

export function syncBackends(): Promise<{
  connected: boolean;
  imported: number;
  reconciled: number;
}> {
  return request("/sync", { method: "POST" });
}

export function optimizeMaintenance(vacuum: boolean): Promise<OptimizeResult> {
  return request<OptimizeResult>("/maintenance/optimize", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ vacuum }),
  });
}

export function backupMaintenance(): Promise<MaintenanceSnapshot> {
  return request<MaintenanceSnapshot>("/maintenance/backup", { method: "POST" });
}

export function deleteBackup(name: string): Promise<MaintenanceSnapshot> {
  return request<MaintenanceSnapshot>(`/maintenance/backups/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export function deleteLegacy(name: string): Promise<MaintenanceSnapshot> {
  return request<MaintenanceSnapshot>(`/maintenance/legacy/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

export function cleanMaintenance(body: {
  mode: "rebuildable";
  session_ids?: string[];
  older_than_days?: number;
  archived_only?: boolean;
  apply?: boolean;
}): Promise<CleanResult> {
  return request<CleanResult>("/maintenance/clean", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function unarchiveSession(id: string): Promise<void> {
  return request<{ ok: true }>(`/sessions/${encodeURIComponent(id)}/unarchive`, {
    method: "POST",
  }).then(() => undefined);
}

export interface SessionData extends CleanTarget {
  backend: boolean;
  /** The connected backend can delete its copy; otherwise only local data goes. */
  can_delete: boolean;
}

export function readSessionData(id: string): Promise<SessionData> {
  return request<SessionData>(`/sessions/${encodeURIComponent(id)}/data`);
}

export function deleteSession(id: string, localOnly: boolean): Promise<{
  ok: true;
  backend: boolean;
  deleted: number;
  local: number;
}> {
  return request(`/sessions/${encodeURIComponent(id)}${localOnly ? "?local=1" : ""}`, {
    method: "DELETE",
  });
}

/**
 * Where new worktree checkouts go.
 *
 * `worktreeRoot` is what the reader chose (null when they never did), and
 * `createsIn` is where the next one would actually land — the chosen folder,
 * or the state dir's own `worktrees` when there is no choice.
 */
export interface WorktreeRootInfo {
  worktreeRoot: string | null;
  createsIn: string | null;
  knownRoots: string[];
}

export function readWorktreeRoot(): Promise<WorktreeRootInfo> {
  return request<WorktreeRootInfo>("/desktop/worktree-root");
}

/** An empty `path` clears the setting and goes back to the default. */
export function setWorktreeRoot(path: string): Promise<{ worktreeRoot: string | null }> {
  return request("/desktop/worktree-root", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
}
