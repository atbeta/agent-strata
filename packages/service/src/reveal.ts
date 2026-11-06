import { dirname } from "node:path";
import { checkPath, type PathErrorCode } from "./paths";

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
 *
 * The failure carries a code next to its sentence: the reader is shown a
 * translated line chosen by the code, and the sentence stays for the logs.
 */
export function revealTarget(
  raw: unknown,
  roots: readonly string[],
): { cmd: string[] } | { error: string; code: PathErrorCode } {
  const check = checkPath(raw, roots);
  if (!check.ok) return { error: check.detail, code: check.code };
  const { path, real, dir } = check;
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
