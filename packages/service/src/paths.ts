import { homedir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";

/**
 * What the service knows about a local path.
 *
 * The same rules the file manager reveal and the editor launcher follow: `~`
 * expands against the service's HOME, the path must be absolute, it must
 * exist, and it must sit inside one of the folders this reader already works
 * in. A path can arrive from rendered text — which the model wrote — so
 * "somebody asked" is not a reason to open anything.
 */

/**
 * Why a path cannot be opened, as a code rather than a sentence.
 *
 * The detail next to it stays English because it is a developer-facing note;
 * the reader is shown a translated sentence chosen by the code. A wire that
 * carried prose would force the other side to match on English to localise
 * anything, and a reworded sentence would break that match.
 */
export type PathErrorCode = "not-a-string" | "not-absolute" | "missing" | "outside";

export type PathCheck =
  | { ok: true; path: string; real: string; dir: boolean }
  | { ok: false; code: PathErrorCode; detail: string };

/**
 * `~` expands here, not in the UI — the service owns HOME.
 *
 * Both separators open the home directory: a Windows reader writes `~\notes`
 * as often as `~/notes`.
 */
export function expandHome(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return homedir() + raw.slice(1);
  return raw;
}

/**
 * The folders a path may land in, resolved for real.
 *
 * A root that does not exist yet is kept as spelled: a workspace created a
 * moment ago is still a workspace, and resolving it would throw away the
 * only spelling we have.
 */
export function allowedRoots(roots: readonly string[]): string[] {
  return roots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return resolve(r);
    }
  });
}

/**
 * Check a batch of paths against the same rules.
 *
 * The roots are resolved once for the whole batch: a transcript can hold
 * dozens of path-shaped tokens, and resolving every root for every one of
 * them is a filesystem round-trip spent on nothing.
 */
export function checkPaths(raws: readonly unknown[], roots: readonly string[]): PathCheck[] {
  const allowed = allowedRoots(roots);
  return raws.map((raw) => checkOne(raw, allowed));
}

/** One path, checked against the same rules. */
export function checkPath(raw: unknown, roots: readonly string[]): PathCheck {
  return checkPaths([raw], roots)[0]!;
}

function checkOne(raw: unknown, allowed: readonly string[]): PathCheck {
  if (typeof raw !== "string" || raw.includes("\0")) {
    return { ok: false, code: "not-a-string", detail: "path must be a string" };
  }
  const path = expandHome(raw);
  if (!isAbsolute(path)) {
    return { ok: false, code: "not-absolute", detail: "path must be absolute" };
  }
  // The real path, not the spelled one: a symlink inside an allowed folder
  // must not be a way out of it.
  let real: string;
  let dir: boolean;
  try {
    real = realpathSync(path);
    dir = statSync(real).isDirectory();
  } catch {
    return { ok: false, code: "missing", detail: "path does not exist" };
  }
  if (!allowed.some((r) => contains(r, real))) {
    return { ok: false, code: "outside", detail: "path is outside the allowed folders" };
  }
  return { ok: true, path, real, dir };
}

/** Is `path` the root itself or inside it? Both sides are real paths. */
export function contains(root: string, path: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path.startsWith(prefix);
}
