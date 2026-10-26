// Reports whether the files that hold secrets are readable by anyone else.
//
// The service writes them with mode 0600, but a mode is a decision that can
// be undone — an older build, a copy made by hand, a backup restored with the
// wrong permissions. This reads the modes and says which files are open to
// the rest of the machine. Read-only.
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dir = process.argv[2] ?? join(homedir(), ".agent-strata");

/** The files that hold a credential, a password, or a policy that says what runs. */
const files = [
  "connections.json",
  "opencode-status.json",
  "desktop.json",
  "policy.json",
  "api-token",
];

const mode = (bits: number) => (bits & 0o777).toString(8).padStart(3, "0");

const rows: { file: string; mode: string; owner_only: boolean }[] = [];
for (const name of files) {
  const path = join(dir, name);
  try {
    const bits = statSync(path).mode;
    // Group and world readable is the question; the owner is the one who
    // wrote the file.
    const ownerOnly = (bits & 0o077) === 0;
    rows.push({ file: path, mode: mode(bits), owner_only: ownerOnly });
  } catch {
    // not written yet
  }
}

const open = rows.filter((row) => !row.owner_only);
for (const row of rows) {
  console.log(`${row.mode}  ${row.owner_only ? "ok " : "OPEN"}  ${row.file}`);
}
if (open.length > 0) {
  console.error(`\n${open.length} file(s) are readable by other accounts on this machine.`);
  process.exit(1);
}
