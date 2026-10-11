/**
 * Compile the strata service into the Tauri sidecar binary.
 *
 * Tauri looks for `src-tauri/binaries/<product>-<target-triple>[.exe]` at bundle
 * time, and the desktop app spawns the same file at run time. That means a
 * fresh checkout has no binary at all: `bun run tauri dev` starts, then fails at
 * spawn time with something unhelpful like "file not found". Building it is a
 * required step, not an optimisation, so it gets a first-class script instead of
 * living in someone's shell history.
 *
 * The target triple defaults to the host's, and can be overridden with
 * `--target` (or STRATA_SIDECAR_TARGET) for cross-compiling.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { $ } from "bun";

const root = resolve(import.meta.dir, "..");
const outDir = join(root, "apps/desktop/src-tauri/binaries");

const argv = Bun.argv.slice(2);
const targetFlag = argv.indexOf("--target");
const override =
  targetFlag >= 0 ? argv[targetFlag + 1] : process.env.STRATA_SIDECAR_TARGET;

const triple = override ?? (await targetTripleFromRustc());
// Tauri v2 matches the suffix to the platform: `foo-x86_64-unknown-linux-gnu`,
// but Windows binaries additionally carry the `.exe`.
const ext = triple.includes("windows") ? ".exe" : "";
const outfile = join(outDir, `strata-service-${triple}${ext}`);

async function targetTripleFromRustc(): Promise<string> {
  // `rustc -vV` prints `host: x86_64-pc-windows-msvc` on its own line. Going
  // through rustc rather than guessing keeps unusual targets (aarch64-apple-darwin
  // under Rosetta, musl hosts) honest.
  try {
    const { stdout } = await $`rustc -vV`.quiet();
    const host = stdout.split("\n").find((l) => l.startsWith("host: "))?.slice(6).trim();
    if (host) return host;
  } catch {
    // rustc is optional for this script: the fallback below is right for the
    // three platforms we actually develop on.
  }
  if (process.platform === "darwin") return "aarch64-apple-darwin";
  if (process.platform === "win32") return "x86_64-pc-windows-msvc";
  return "x86_64-unknown-linux-gnu";
}

mkdirSync(outDir, { recursive: true });

const SKIP_DIRS = new Set(["node_modules", "dist", "target", ".git"]);

/**
 * The newest thing that can change the binary, and when.
 *
 * Everything the compile reads lives under `packages/` — the service entry
 * reaches its siblings through `@agent-strata/*`, so there is no import that
 * escapes the workspace. Walking the whole set rather than the transitive
 * imports of the entry is deliberate: a resolved graph would be narrower and
 * faster, but it has to be right about aliases and dynamic imports, and the
 * failure mode when it is wrong is the exact one this function exists to
 * prevent — a stale binary that looks current.
 *
 * This compares timestamps, not content, so it answers "could this edit have
 * reached the binary". That errs towards rebuilding: a checkout that rewrites
 * files without changing them costs one compile and nothing else.
 */
function newestInput(): { path: string; mtime: number } {
  // The script is a seed rather than a root: it is a file, so it cannot be
  // walked, and changing a build flag here has to force a rebuild like any
  // other input.
  let newest = { path: import.meta.path, mtime: statSync(import.meta.path).mtimeMs };
  const stack = [join(root, "packages")];

  while (stack.length) {
    const path = stack.pop()!;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(child);
        continue;
      }
      if (!/\.(ts|tsx|json)$/.test(entry.name)) continue;
      const { mtimeMs } = statSync(child);
      if (mtimeMs > newest.mtime) newest = { path: child, mtime: mtimeMs };
    }
  }
  return { path: relative(root, newest.path), mtime: newest.mtime };
}

// Rebuilding a ~95MB binary takes long enough that a no-op check is worth the
// extra stat -- but only if the check actually knows what it is comparing. It
// used to ask only whether the binary existed and had bytes in it, which any
// checkout satisfied: edit a handler, run this, get "sidecar up to date" and
// an hour of testing against the code you replaced an hour ago. --force is
// there for when a rebuild is wanted anyway.
const force = argv.includes("--force");
if (!force && existsSync(outfile)) {
  const bytes = statSync(outfile).size;
  const newest = newestInput();
  const built = statSync(outfile).mtimeMs;
  if (bytes > 0 && built >= newest.mtime) {
    console.log(`sidecar up to date: ${outfile} (${(bytes / 1e6).toFixed(1)} MB)`);
    console.log("pass --force to rebuild anyway.");
    process.exit(0);
  }
  if (bytes > 0) {
    // Name the input, because "it is stale" on a 69-file package tree is not
    // something anyone can act on.
    console.log(`rebuilding: ${newest.path} is newer than the binary`);
  }
}

console.log(`building sidecar for ${triple} -> ${outfile}`);
// --windows-hide-console keeps the sidecar from opening a console window, and
// bun rejects it on any other target, so it cannot just stay in the command.
const hideConsole = triple.includes("windows") ? ["--windows-hide-console"] : [];
await $`bun build --compile ${hideConsole} ./packages/service/src/index.ts --outfile ${outfile}`;

const size = statSync(outfile).size;
console.log(`built ${outfile} (${(size / 1e6).toFixed(1)} MB)`);