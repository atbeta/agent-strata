import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write a file only its owner can read.
 *
 * The files this writes hold credentials — the basic-auth pair of an embedded
 * server, a live policy that says which tools run without asking. A mode that
 * lets another account on the machine read them is a secret on disk, and the
 * umask is not something to rely on: it is a default, not a decision.
 *
 * The mode is set twice on purpose. `writeFileSync` applies it only when it
 * creates the file, so a file that was already there keeps its old mode; the
 * explicit `chmod` narrows that one too.
 */
export function writeSecureJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows has no unix mode to set; the file inherits the directory's ACL.
  }
}
