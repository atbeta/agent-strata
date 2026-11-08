// Whether a path is inside a directory.
//
// One function, its own module, because two callers now ask the question for
// different reasons — the service (does this session live in the folder being
// removed) and the plugin host (does this tool input stay in the workspace) —
// and neither should have to import a process manager to ask it.

import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Real paths where they exist; the resolved spelling otherwise. */
function realish(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Whether `target` is `root` or below it, however either was spelled.
 *
 * Both sides are resolved through symbolic links where they exist, because a
 * checkout reached through one is the same folder as the one reached
 * directly, and a guard that says otherwise is a guard that can be walked
 * around with a link.
 */
export function pathInside(root: string, target: string): boolean {
  return insideWorkspace(realish(root), realish(target));
}

function insideWorkspace(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return true;
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  // Windows compares case-insensitively: `C:\Users` and `c:\users` are one
  // folder, and a guard that treats them as two would refuse a valid path.
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const base = fold(root);
  const child = fold(target);
  const prefix = base.endsWith(sep) ? base : base + sep;
  return child === base || child.startsWith(prefix);
}

/** Resolve a path against a root, refusing anything that leaves it. */
export function resolveInside(root: string, target: string): string {
  const base = resolve(root);
  const full = isAbsolute(target) ? resolve(target) : resolve(base, target);
  if (!pathInside(base, full)) {
    throw new Error(`workdir must stay inside the session workspace (${base})`);
  }
  return full;
}
