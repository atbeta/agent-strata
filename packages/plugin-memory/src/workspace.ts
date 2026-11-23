// The workspace a memory belongs to.
//
// A workspace is a directory, and a directory is not a name: it moves, it is
// symlinked, and two of them can be the same place under different names. The
// key is therefore derived from the resolved path, and the path itself is
// kept beside it in the index, because a key nobody can read back is a key
// nobody can debug.

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** The resolved path, so two names for one directory get one key. */
export function realish(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** A short, stable name for a workspace directory. */
export function workspaceKey(path: string): string {
  return createHash("sha256").update(realish(path)).digest("hex").slice(0, 16);
}
