import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { DevManager } from "./types";

/**
 * The directory a command runs in, confined to the session workspace.
 *
 * `workdir` is how a command names a subdirectory. Putting `cd` or
 * `Set-Location` in the command string fails when the shell is not already
 * there, and an absolute path outside the workspace is a path that leaves
 * the project. An empty value is the workspace itself.
 */
export function resolveWorkdir(workspace: string, workdir?: string): string {
  const root = resolve(workspace);
  const raw = workdir?.trim() ?? "";
  if (raw.length === 0) return root;
  const target = resolve(root, raw);
  // Compare real paths, not spellings: a symlink inside the workspace can
  // point outside it, and a lexical prefix check would call that a child.
  if (!pathInside(root, target)) {
    throw new Error(`workdir must stay inside the session workspace (${root})`);
  }
  return target;
}

/**
 * Stop every process running inside a directory.
 *
 * A program with its working directory inside a folder keeps that folder
 * locked on Windows, and `git worktree remove` answers "Permission denied" and
 * leaves the worktree exactly where it was. The app owns these processes, so
 * it can stop them itself — and it should: the folder is on its way out, and
 * a server left running in a deleted directory is only holding a port.
 *
 * Returns how many were stopped.
 */
export async function stopInside(dev: DevManager, dir: string): Promise<number> {
  const root = realish(dir);
  let stopped = 0;
  for (const proc of dev.list()) {
    if (!insideWorkspace(root, realish(proc.cwd))) continue;
    const result = await dev.stop(proc.id);
    if (result.stopped) stopped++;
  }
  return stopped;
}

/** The path with its symlinks resolved, so two spellings of one folder match. */
function realish(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Is this path inside that one? The answer has to hold for spellings that
 *  differ only in case or in a symbolic link. */
export function insideWorkspace(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const base = fold(root);
  const child = fold(target);
  const prefix = base.endsWith(sep) ? base : base + sep;
  return child === base || child.startsWith(prefix);
}

/**
 * Is this path inside that one, however either was spelled?
 *
 * Two spellings of one folder — a symbolic link on one side, a different case
 * on the other — have to answer the same way, or a program standing in a
 * checkout is invisible to the thing that wants to let go of it.
 */
export function pathInside(root: string, target: string): boolean {
  return insideWorkspace(realish(root), realish(target));
}

/** Real paths where they exist, so a symlinked checkout is the same folder. */
export function canonicalPath(path: string): string {
  return realish(path);
}
