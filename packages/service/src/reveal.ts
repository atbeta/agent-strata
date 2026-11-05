import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import { statSync } from "node:fs";

/**
 * The file-manager command a "reveal this path" request maps to.
 *
 * `~` expands here, not in the UI — the service owns HOME. Everything else is
 * validated like the editor launcher: absolute, exists, no NUL. The platform
 * picks the verb — Finder selects files but opens folders, Explorer uses
 * `/select,`, and `xdg-open` can only open the enclosing directory.
 */
export function revealTarget(raw: unknown): { cmd: string[] } | { error: string } {
  if (typeof raw !== "string" || raw.includes("\0")) return { error: "path must be a string" };
  const path = raw === "~" ? homedir() : raw.startsWith("~/") ? homedir() + raw.slice(1) : raw;
  if (!isAbsolute(path)) return { error: "path must be absolute" };
  let dir: boolean;
  try {
    dir = statSync(path).isDirectory();
  } catch {
    return { error: "path does not exist" };
  }
  switch (process.platform) {
    case "darwin":
      return { cmd: dir ? ["open", path] : ["open", "-R", path] };
    case "win32":
      return { cmd: ["explorer", dir ? path : `/select,${path}`] };
    default:
      return { cmd: ["xdg-open", dir ? path : dirname(path)] };
  }
}
