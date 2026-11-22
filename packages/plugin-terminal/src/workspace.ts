import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function realish(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function pathInside(root: string, target: string): boolean {
  const base = realish(root);
  const child = realish(target);
  const rel = relative(base, child);
  if (rel === "") return true;
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const left = fold(base);
  const right = fold(child);
  return right.startsWith(left.endsWith(sep) ? left : left + sep);
}

export function resolveWorkdir(workspace: string, workdir?: string): string {
  const root = resolve(workspace);
  const target = workdir?.trim() ? resolve(root, workdir.trim()) : root;
  if (!pathInside(root, target)) throw new Error(`workdir must stay inside the session workspace (${root})`);
  return target;
}
