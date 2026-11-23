// The memory files on disk.
//
// Two plain JSON files, one for the facts that hold everywhere and one per
// workspace, plus an index of the workspaces the plugin has seen. Plain JSON
// is not a limitation: the reader edits these by hand, and a file a person can
// read is the point.
//
// Three properties the rest of the plugin depends on:
//
// - A write never leaves a half-written file. The new content goes to a
//   temporary file and is renamed over the old one, so a crash mid-write
//   leaves the previous version, not a broken one.
// - A file that is not valid JSON is reported, never overwritten. A hand edit
//   that goes wrong must not cost the reader every other memory.
// - A read is cheap. The file's size and mtime decide whether the parsed copy
//   is still current, so the system prompt can be rebuilt on every model call
//   without touching the disk twice.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryEntry, MemoryFile, MemoryScope, WorkspaceEntry, WorkspaceIndex } from "./types";
import { EMPTY_FILE } from "./types";

export class MemoryStoreError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

/** How stale a workspace's last use may get before the index is written again. */
const TOUCH_INTERVAL_MS = 60_000;

export interface MemoryStoreOptions {
  /** The plugin's own data directory; every file lives under it. */
  dataDir: string;
  /** How many entries one file may hold. */
  maxEntries: number;
  /** How long one entry may be. */
  maxEntryChars: number;
}

interface Loaded {
  file: MemoryFile;
  /** `size:mtime` of the bytes this was parsed from; `none` for a file that is not there. */
  stamp: string;
}

export class MemoryStore {
  private readonly cache = new Map<string, Loaded>();

  constructor(private readonly options: MemoryStoreOptions) {}

  get root(): string {
    return join(this.options.dataDir, "memory");
  }

  globalPath(): string {
    return join(this.root, "global.json");
  }

  workspacePath(key: string): string {
    return join(this.root, "workspaces", `${key}.json`);
  }

  indexPath(): string {
    return join(this.root, "workspaces.json");
  }

  pathFor(scope: MemoryScope, key?: string): string {
    if (scope === "global") return this.globalPath();
    if (!key) throw new MemoryStoreError("a workspace scope needs a workspace key");
    return this.workspacePath(key);
  }

  /** Every entry in one file, in the order it was written. */
  read(scope: MemoryScope, key?: string): MemoryFile {
    return this.load(this.pathFor(scope, key)).file;
  }

  /**
   * Read, change, write — as one step, so two writers in this process cannot
   * interleave. The file is re-read from disk inside the step, which is also
   * how a hand edit made a moment ago is picked up rather than lost.
   */
  mutate(scope: MemoryScope, key: string | undefined, change: (file: MemoryFile) => void): MemoryFile {
    const path = this.pathFor(scope, key);
    const loaded = this.load(path);
    change(loaded.file);
    loaded.file.revision += 1;
    this.assertUnchanged(path, loaded.stamp);
    this.writeFile(path, loaded.file);
    return loaded.file;
  }

  /** The workspaces the plugin has seen, newest first. */
  readIndex(): WorkspaceIndex {
    const path = this.indexPath();
    if (!existsSync(path)) return { version: 1, workspaces: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new MemoryStoreError("the workspace index is not valid JSON; fix or delete it by hand");
    }
    const rows = (parsed as { workspaces?: unknown })?.workspaces;
    if (!Array.isArray(rows)) return { version: 1, workspaces: [] };
    const workspaces: WorkspaceEntry[] = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const item = row as Record<string, unknown>;
      if (typeof item.key !== "string" || typeof item.path !== "string") continue;
      workspaces.push({
        key: item.key,
        path: item.path,
        last_used: typeof item.last_used === "string" ? item.last_used : "",
      });
    }
    return { version: 1, workspaces };
  }

  /**
   * Record that a workspace was used, so the settings page can offer it.
   *
   * The system prompt is rebuilt on every model call, and a workspace is
   * usually the same one it was five calls ago: writing the index each time
   * would be a file write per turn for no new information. The entry is
   * rewritten only when the workspace is new or the last use is old enough to
   * be worth showing.
   */
  touchWorkspace(key: string, path: string, at: string): void {
    const index = this.readIndex();
    const existing = index.workspaces.find((row) => row.key === key);
    if (existing && existing.path === path && Date.now() - Date.parse(existing.last_used) < TOUCH_INTERVAL_MS) {
      return;
    }
    const rest = index.workspaces.filter((row) => row.key !== key);
    this.writeFile(this.indexPath(), {
      version: 1,
      workspaces: [{ key, path, last_used: at }, ...rest].slice(0, 50),
    });
  }

  forgetWorkspace(key: string): void {
    const index = this.readIndex();
    this.writeFile(this.indexPath(), {
      version: 1,
      workspaces: index.workspaces.filter((row) => row.key !== key),
    });
  }

  private load(path: string): Loaded {
    if (!existsSync(path)) {
      const loaded: Loaded = { file: { ...EMPTY_FILE, memories: [] }, stamp: "none" };
      this.cache.set(path, loaded);
      return loaded;
    }
    const stamp = this.stamp(path);
    const cached = this.cache.get(path);
    if (cached && cached.stamp === stamp) return cached;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new MemoryStoreError(
        `${path} is not valid JSON — fix it by hand or delete it; nothing has been overwritten`,
      );
    }
    const loaded: Loaded = { file: normalize(parsed), stamp };
    this.cache.set(path, loaded);
    return loaded;
  }

  /** `size:mtime` of the bytes on disk. */
  private stamp(path: string): string {
    try {
      const info = statSync(path);
      return `${info.size}:${info.mtimeMs}`;
    } catch {
      return "none";
    }
  }

  /**
   * Refuse to write over a file that changed since it was read. The window is
   * the two calls between reading and writing; a person editing the file by
   * hand in that window would otherwise lose their edit silently.
   */
  private assertUnchanged(path: string, stamp: string): void {
    if (this.stamp(path) !== stamp) {
      throw new MemoryStoreError(
        "the memory file changed while this edit was being prepared; nothing was written — try again",
        409,
      );
    }
  }

  private writeFile(path: string, file: MemoryFile | WorkspaceIndex): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (error) {
      try {
        unlinkSync(tmp);
      } catch {
        // The temporary file was never created.
      }
      throw error;
    }
    this.cache.delete(path);
  }
}

/**
 * Read a file that may have been written by a person rather than by this
 * plugin. Entries that cannot be understood are dropped rather than guessed
 * at; the rest are brought to the shape the plugin works with.
 */
function normalize(parsed: unknown): MemoryFile {
  if (!parsed || typeof parsed !== "object") {
    throw new MemoryStoreError("the memory file is not an object; fix or delete it by hand");
  }
  const row = parsed as Record<string, unknown>;
  if (row.version !== 1) {
    throw new MemoryStoreError("the memory file has an unknown version; fix or delete it by hand");
  }
  const rows = row.memories;
  if (!Array.isArray(rows)) {
    throw new MemoryStoreError("the memory file has no `memories` array; fix or delete it by hand");
  }
  const now = new Date().toISOString();
  const memories: MemoryEntry[] = [];
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || !entry.id) continue;
    if (typeof entry.text !== "string" || !entry.text.trim()) continue;
    memories.push({
      id: entry.id,
      text: entry.text,
      enabled: entry.enabled !== false,
      ...(typeof entry.key === "string" && entry.key ? { key: entry.key } : {}),
      source: entry.source === "user" ? "user" : "agent",
      created_at: typeof entry.created_at === "string" ? entry.created_at : now,
      updated_at: typeof entry.updated_at === "string" ? entry.updated_at : now,
    });
  }
  return {
    version: 1,
    revision: typeof row.revision === "number" && Number.isFinite(row.revision) ? row.revision : 0,
    memories,
  };
}
