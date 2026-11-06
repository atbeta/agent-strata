import { homedir } from "node:os";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { realpathSync, statSync } from "node:fs";

/**
 * The file-manager command a "reveal this path" request maps to.
 *
 * `~` expands here, not in the UI — the service owns HOME. Everything else is
 * validated like the editor launcher: absolute, exists, no NUL. The platform
 * picks the verb — Finder selects files but opens folders, Explorer uses
 * `/select,`, and `xdg-open` can only open the enclosing directory.
 *
 * A reveal may only land inside one of `roots` — the folders the reader
 * already works in. The path can come from rendered text, which the model
 * wrote, so "somebody asked" is not a reason to open anything: the target is
 * resolved for real (symlinks included) and refused when it falls outside.
 */
export function revealTarget(
  raw: unknown,
  roots: readonly string[],
): { cmd: string[] } | { error: string } {
  if (typeof raw !== "string" || raw.includes("\0")) return { error: "path must be a string" };
  const path = raw === "~" ? homedir() : raw.startsWith("~/") ? homedir() + raw.slice(1) : raw;
  if (!isAbsolute(path)) return { error: "path must be absolute" };
  // The real path, not the spelled one: a symlink inside an allowed folder
  // must not be a way out of it.
  let real: string;
  let dir: boolean;
  try {
    real = realpathSync(path);
    dir = statSync(real).isDirectory();
  } catch {
    return { error: "path does not exist" };
  }
  const allowed = roots.map((r) => {
    try {
      return realpathSync(r);
    } catch {
      return resolve(r);
    }
  });
  if (!allowed.some((r) => contains(r, real)))
    return { error: "path is outside the allowed folders" };
  switch (process.platform) {
    case "darwin":
      // `open` on an application bundle launches it. A folder opens in
      // Finder — unless it is a bundle, which is selected rather than run.
      return dir && !real.toLowerCase().endsWith(".app")
        ? { cmd: ["open", path] }
        : { cmd: ["open", "-R", path] };
    case "win32":
      return { cmd: ["explorer", dir ? path : `/select,${path}`] };
    default:
      return { cmd: ["xdg-open", dir ? path : dirname(real)] };
  }
}

/** Is `path` the root itself or inside it? Both sides are real paths. */
function contains(root: string, path: string): boolean {
  if (path === root) return true;
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return path.startsWith(prefix);
}
