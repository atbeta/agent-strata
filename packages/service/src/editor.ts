import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

export type EditorId = "cursor" | "vscode";

const BINS: Record<EditorId, string> = {
  cursor: "cursor",
  vscode: "code",
};

/** The launcher and the file it may open. Anything else is refused. */
export function editorLaunch(editor: unknown, file: unknown): { bin: string; file: string } | { error: string } {
  if (editor !== "cursor" && editor !== "vscode") return { error: "editor must be cursor or vscode" };
  if (typeof file !== "string" || file.includes("\0") || !isAbsolute(file)) return { error: "path must be absolute" };
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return { error: "path is not a file" };
  } catch {
    return { error: "path is not a file" };
  }
  return { bin: BINS[editor], file };
}
