// The memory plugin's management surface.
//
// The reader's side of the store: what the agent remembered, what it is worth
// keeping, and what to turn off. Everything here goes through the plugin's
// own routes, so the page and the agent work on the same files.

import { apiFetch } from "./api";
import { t } from "./i18n";

export type MemoryScope = "global" | "workspace";

export interface MemoryEntry {
  id: string;
  text: string;
  enabled: boolean;
  key?: string;
  source: "agent" | "user";
  created_at: string;
  updated_at: string;
}

export interface MemoryWorkspace {
  key: string;
  path: string;
  last_used: string;
}

export function parseMemoryEntry(value: unknown): MemoryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) return null;
  if (typeof row.text !== "string" || !row.text) return null;
  return {
    id: row.id,
    text: row.text,
    enabled: row.enabled !== false,
    ...(typeof row.key === "string" && row.key ? { key: row.key } : {}),
    source: row.source === "user" ? "user" : "agent",
    created_at: typeof row.created_at === "string" ? row.created_at : "",
    updated_at: typeof row.updated_at === "string" ? row.updated_at : "",
  };
}

export function parseMemoryWorkspace(value: unknown): MemoryWorkspace | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.key !== "string" || !row.key) return null;
  if (typeof row.path !== "string") return null;
  return {
    key: row.key,
    path: row.path,
    last_used: typeof row.last_used === "string" ? row.last_used : "",
  };
}

async function responseError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(
    typeof body?.error === "string" ? body.error : t("api.err.service", { status: res.status }),
  );
}

const PLUGIN = "memory";

function query(scope: MemoryScope, workspace?: string): string {
  const params = new URLSearchParams({ scope });
  if (scope === "workspace" && workspace) params.set("workspace", workspace);
  return params.toString();
}

export async function listMemoryWorkspaces(): Promise<MemoryWorkspace[]> {
  const res = await apiFetch(`/plugins/${PLUGIN}/workspaces`, { cache: "no-store" });
  if (!res.ok) throw await responseError(res);
  const body = (await res.json().catch(() => null)) as { workspaces?: unknown } | null;
  if (!Array.isArray(body?.workspaces)) return [];
  return body.workspaces
    .map(parseMemoryWorkspace)
    .filter((row): row is MemoryWorkspace => row !== null);
}

export async function listMemories(
  scope: MemoryScope,
  workspace?: string,
): Promise<MemoryEntry[]> {
  const res = await apiFetch(`/plugins/${PLUGIN}/memories?${query(scope, workspace)}`, {
    cache: "no-store",
  });
  if (!res.ok) throw await responseError(res);
  const body = (await res.json().catch(() => null)) as { memories?: unknown } | null;
  if (!Array.isArray(body?.memories)) return [];
  return body.memories
    .map(parseMemoryEntry)
    .filter((row): row is MemoryEntry => row !== null);
}

export async function createMemory(
  scope: MemoryScope,
  workspace: string | undefined,
  text: string,
  key?: string,
): Promise<MemoryEntry> {
  const res = await apiFetch(`/plugins/${PLUGIN}/memories?${query(scope, workspace)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, ...(key ? { key } : {}) }),
  });
  if (!res.ok) throw await responseError(res);
  const body = (await res.json().catch(() => null)) as { memory?: unknown } | null;
  const entry = parseMemoryEntry(body?.memory);
  if (!entry) throw new Error("the memory was not saved");
  return entry;
}

export async function updateMemory(
  scope: MemoryScope,
  workspace: string | undefined,
  id: string,
  change: { text?: string; enabled?: boolean },
): Promise<MemoryEntry> {
  const res = await apiFetch(
    `/plugins/${PLUGIN}/memories/${encodeURIComponent(id)}?${query(scope, workspace)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(change),
    },
  );
  if (!res.ok) throw await responseError(res);
  const body = (await res.json().catch(() => null)) as { memory?: unknown } | null;
  const entry = parseMemoryEntry(body?.memory);
  if (!entry) throw new Error("the memory was not saved");
  return entry;
}

export async function deleteMemory(
  scope: MemoryScope,
  workspace: string | undefined,
  id: string,
): Promise<void> {
  const res = await apiFetch(
    `/plugins/${PLUGIN}/memories/${encodeURIComponent(id)}?${query(scope, workspace)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw await responseError(res);
}

/**
 * Forget everything in one scope, or in all of them.
 *
 * Disabling the plugin stops the reading; this drops what was written. They
 * are different acts, and a reader who wants the second should not have to
 * find the data directory by hand.
 */
export async function forgetMemories(
  scope: MemoryScope | "all",
  workspace?: string,
): Promise<number> {
  const params = new URLSearchParams({ scope });
  if (scope === "workspace" && workspace) params.set("workspace", workspace);
  const res = await apiFetch(`/plugins/${PLUGIN}/memories?${params.toString()}`, {
    method: "DELETE",
  });
  if (!res.ok) throw await responseError(res);
  const body = (await res.json().catch(() => null)) as { forgotten?: unknown } | null;
  return typeof body?.forgotten === "number" ? body.forgotten : 0;
}
