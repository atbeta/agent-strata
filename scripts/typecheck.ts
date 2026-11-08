// Typecheck every project in the workspace.
//
// This was a shell one-liner in package.json — a `for` loop over the project
// directories — and it only ran where a POSIX shell was there to read it. On
// Windows the script runner hands the command to a shell that has no `for`,
// so the check that guards every package could not start at all: the failure
// was a usage message, not a diagnosis. The list lives here now, so the same
// runner reads it the same way on every machine.
//
// The compiler is called by its own path rather than through `tsc` on the
// path: it lives in node_modules, and on Windows the shim there is a `.cmd`
// that a spawn without a shell cannot run.
import { join } from "node:path";

const root = join(import.meta.dir, "..");

/**
 * The projects to check, in the order the original script listed them.
 *
 * The root tsconfig is not among them: it is a solution file with no sources
 * of its own, so there is nothing in it to check.
 */
const projects = [
  "packages/api",
  "packages/schema",
  "packages/store",
  "packages/projector",
  "packages/policy",
  "packages/adapter-acp",
  "packages/adapter-opencode",
  "packages/core",
  "packages/plugin-sdk",
  "packages/plugin-dev-process",
  "packages/plugin-echo",
  "packages/service",
  "apps/desktop/ui",
  "apps/desktop/ui/bench",
];

const compiler = join(root, "node_modules/typescript/lib/tsc.js");

let failed = false;
for (const project of projects) {
  const result = Bun.spawnSync([process.execPath, compiler, "--noEmit", "-p", project], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode === 0) {
    console.log(`ok    ${project}`);
    continue;
  }
  failed = true;
  console.error(`FAIL  ${project}`);
  const errors = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
  if (errors) console.error(errors);
}

if (failed) {
  console.error("\nTypecheck failed: the projects above did not compile.");
  process.exit(1);
}
console.log(`typecheck passed (${projects.length} projects)`);
