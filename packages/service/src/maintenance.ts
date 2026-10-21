import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export interface FileInfo {
  name: string;
  path: string;
  bytes: number;
  modified_at: number;
}

export function fileInfo(path: string, name = basename(path)): FileInfo | undefined {
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return undefined;
    return { name, path, bytes: stat.size, modified_at: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

/** Managed copies live in a subdirectory, one file each, newest first. */
export function listBackups(dir: string): FileInfo[] {
  const root = join(dir, "backups");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".db") && name === basename(name))
    .map((name) => fileInfo(join(root, name), name))
    .filter((info): info is FileInfo => info !== undefined)
    .sort((a, b) => b.modified_at - a.modified_at);
}

/**
 * Snapshots left by hand, next to the live database. They are not part of the
 * app's own backup set, but they are the largest thing in most profiles and a
 * maintenance screen that cannot see them is not answering the disk question.
 */
export function listLegacy(dir: string): FileInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name !== "backups" && name.includes(".bak") && name === basename(name))
    .map((name) => fileInfo(join(dir, name), name))
    .filter((info): info is FileInfo => info !== undefined)
    .sort((a, b) => b.bytes - a.bytes);
}

/** Stored names never carry a path; deleting one cannot escape its directory. */
export function safeName(name: string): boolean {
  return name.length > 0 && name === basename(name) && name !== "." && name !== ".." && !name.includes("\0");
}

export function backupName(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `events-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}.db`;
}

/** The backup a `VACUUM INTO` can actually create: the name is not taken yet. */
export function availableBackupName(dir: string, now = new Date()): string {
  const root = join(dir, "backups");
  const base = backupName(now);
  if (!existsSync(join(root, base))) return base;
  const stem = base.slice(0, -3);
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-${i}.db`;
    if (!existsSync(join(root, candidate))) return candidate;
  }
  throw new Error("could not choose a backup name");
}

export function maintenanceDirs(db: string | undefined, desktopDir: string): {
  dir: string;
  dbPath: string | null;
  backupDir: string;
} {
  const dbPath = db && db !== ":memory:" ? db : null;
  const dir = dbPath ? join(dbPath, "..") : desktopDir;
  return { dir, dbPath, backupDir: join(dir, "backups") };
}
