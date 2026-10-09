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
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

// Rebuilding a ~95MB binary takes long enough that a no-op check is worth the
// extra stat. --force is there for when a stale binary is more annoying than the
// wait.
const force = argv.includes("--force");
if (!force && existsSync(outfile)) {
  const bytes = statSync(outfile).size;
  if (bytes > 0) {
    console.log(`sidecar up to date: ${outfile} (${(bytes / 1e6).toFixed(1)} MB)`);
    console.log("pass --force to rebuild anyway.");
    process.exit(0);
  }
}

console.log(`building sidecar for ${triple} -> ${outfile}`);
await $`bun build --compile --windows-hide-console ./packages/service/src/index.ts --outfile ${outfile}`;

const size = statSync(outfile).size;
console.log(`built ${outfile} (${(size / 1e6).toFixed(1)} MB)`);