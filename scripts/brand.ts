#!/usr/bin/env bun
/**
 * Resolve the brand this build carries, and write it where every half reads it.
 *
 * A white-label build is the same program with a different name, a different
 * bundle id, and a different place to keep its data. Three consumers need that
 * answer and they need the same one:
 *
 *   - Tauri, for `productName` and `identifier` — the installer's name, the
 *     bundle id a machine can hold one of, and the window title;
 *   - Rust, for the data directory;
 *   - Vite, for the name the page states in its About panel and its title.
 *
 * Tauri's config is JSON read at build time, so the answer is written as an
 * overlay that `tauri build --config` merges in. Rust gets a file of constants.
 * The page gets a Vite define, computed from the same resolution here.
 *
 * Nothing is written when the environment says nothing: the upstream build is
 * what a plain `bun run build` means, and a file restating the defaults would
 * only give a reviewer something to diff.
 *
 * ## Keeping a fork mergeable
 *
 * This repository is expected to be forked for a company build, and a fork has
 * to take upstream changes without a conflict in every file that mentions a
 * name. So this script carries **no** company identity of its own: presets come
 * from `brand.local.ts`, which `.gitignore` excludes. A fork adds that one file
 * and nothing else, and every upstream commit keeps applying cleanly.
 *
 * The same reasoning is why the icon set is a directory the overlay points at
 * rather than a path baked into the committed config.
 *
 * Usage:
 *   bun run brand                          # resolve from the environment
 *   bun run brand --print                  # print the resolved brand
 *   bun run brand --clean                  # remove the generated files
 *   bun run brand --scaffold               # write brand.local.ts to start from
 *   STRATA_BRAND=company bun run brand     # a preset from brand.local.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `import.meta.dir` is Bun-only, and this module is also loaded by Vite when it
// bundles the page's config — where it is undefined and `join` throws. The URL
// form works in both.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const tauriDir = join(root, "apps/desktop/src-tauri");
const overlayPath = join(tauriDir, "brand.overlay.json");
const rustPath = join(tauriDir, "brand.generated.rs");
const localPath = join(here, "brand.local.ts");

export type Brand = {
  productName: string;
  identifier: string;
  dataDir: string;
  sourceUrl: string;
  sourceLabel: string;
  /**
   * The bundled icon set, relative to `src-tauri`.
   *
   * A white-label build brings its own marks; the upstream set stays where it
   * is, so a fork does not have to overwrite files that upstream keeps editing.
   */
  icons?: string[];
};

/** The upstream build. Every field is what the app has always been. */
export const UPSTREAM: Brand = {
  productName: "Agent Strata",
  identifier: "me.pbeta.agent-strata",
  dataDir: ".agent-strata",
  sourceUrl: "https://github.com/atbeta/agent-strata",
  sourceLabel: "atbeta/agent-strata",
};

/**
 * The presets this build knows about.
 *
 * Read from `brand.local.ts`, which is git-ignored: an upstream checkout has
 * none, so this repository stays free of any one company's identity. A fork
 * writes that file once and inherits every later upstream change without a
 * conflict.
 */
async function presets(): Promise<Record<string, Brand>> {
  if (!existsSync(localPath)) return {};
  const module = (await import(localPath)) as { PRESETS?: Record<string, Brand> };
  return module.PRESETS ?? {};
}

const clean = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * The brand this environment asks for.
 *
 * `STRATA_BRAND` picks a preset; the `STRATA_BRAND_*` variables override one
 * field of it. A preset applied first and a field after it means a build can
 * take a company's identity and change one thing without restating the rest.
 *
 * A preset that was named but cannot be found is an error, not a warning.
 *
 * The temptation is to carry on with the upstream name and let the build
 * succeed. That is the worse outcome: a release that says the wrong company's
 * name looks like it worked, ships, and is only noticed when someone reads the
 * installer. A CI job that fails on a missing preset costs one re-run; a
 * mislabelled release costs a recall.
 *
 * The specific way to hit this: `brand.local.ts` is git-ignored, so it is not in
 * CI. A fork that sets `STRATA_BRAND=company` as a repository variable but
 * never provides that file gets here — and should.
 *
 * Overriding with `STRATA_BRAND_*` alone stays fine: that names no preset, so
 * there is nothing to resolve and nothing to be missing.
 */
export async function resolveBrand(
  env: Record<string, string | undefined> = process.env,
): Promise<Brand> {
  const preset = clean(env.STRATA_BRAND);
  const known = await presets();
  let base = UPSTREAM;
  if (preset) {
    const hit = known[preset.toLowerCase()];
    if (hit) {
      base = hit;
    } else if (Object.keys(known).length > 0) {
      throw new Error(
        `brand: no preset "${preset}" in ${localPath}; known: ${Object.keys(known).join(", ")}`,
      );
    } else {
      throw new Error(
        `brand: no preset "${preset}": ${localPath} does not exist.\n` +
          `  A fork supplies it with \`bun run brand --scaffold\`, or sets the\n` +
          `  STRATA_BRAND_* variables instead and leaves STRATA_BRAND unset.`,
      );
    }
  }
  return {
    productName: clean(env.STRATA_BRAND_NAME) ?? base.productName,
    identifier: clean(env.STRATA_BRAND_IDENTIFIER) ?? base.identifier,
    dataDir: clean(env.STRATA_BRAND_DATA_DIR) ?? base.dataDir,
    sourceUrl: clean(env.STRATA_BRAND_SOURCE_URL) ?? base.sourceUrl,
    sourceLabel: clean(env.STRATA_BRAND_SOURCE_LABEL) ?? base.sourceLabel,
    ...(base.icons ? { icons: base.icons } : {}),
  };
}

/** Whether a brand differs from the upstream one in any field. */
export function isCustom(brand: Brand): boolean {
  const keys = Object.keys(UPSTREAM) as (keyof Brand)[];
  if (keys.some((key) => brand[key] !== UPSTREAM[key])) return true;
  return brand.icons !== undefined;
}

/**
 * The window list, copied from the committed config with the titled one renamed.
 *
 * `--config` is a JSON Merge Patch (RFC 7386), where an array is replaced
 * wholesale rather than merged element by element. Writing
 * `app.windows: [{ label, title }]` therefore did not add a title to the window
 * — it deleted every other setting on it: `visible: false` (the blank-window
 * flash it exists to prevent), the size and minimum size, the macOS overlay
 * title bar, the dark background, and `dragDropEnabled: false`, whose loss
 * hands file drops to Tauri instead of the page and quietly breaks dragging a
 * file onto the composer.
 *
 * So the array is rebuilt in full from what the config actually says, changing
 * only the title of the window that carries the product's name. Reading it here
 * rather than committing a copy is what keeps a fork in step with upstream: the
 * generator runs at build time, so it always sees the current config.
 */
export function windowsOverlay(conf: unknown, productName: string): unknown[] | undefined {
  const windows = (conf as { app?: { windows?: unknown } } | null)?.app?.windows;
  if (!Array.isArray(windows)) return undefined;
  return windows.map((w) => {
    const window = (w ?? {}) as Record<string, unknown>;
    // The main window is the one the shell shows and titles; a secondary window
    // that happens to be named would keep its own title.
    return window.label === "main" ? { ...window, title: productName } : window;
  });
}

/** The committed window list, read for `windowsOverlay`. */
function committedConfig(): unknown {
  const path = join(tauriDir, "tauri.conf.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * The Tauri overlay: the fields Tauri itself reads, plus the window title.
 *
 * Only the fields that differ from the committed config are written. `--config`
 * merges a partial overlay over `tauri.conf.json`, and an overlay that restated
 * everything would go stale the moment an upstream default changed.
 *
 * The window list is the exception, and only because arrays cannot be merged:
 * see `windowsOverlay`.
 */
export function overlay(brand: Brand): Record<string, unknown> {
  const out: Record<string, unknown> = {
    productName: brand.productName,
    identifier: brand.identifier,
    app: {},
  };
  const windows = windowsOverlay(committedConfig(), brand.productName);
  if (windows) (out.app as Record<string, unknown>).windows = windows;
  if (brand.icons !== undefined) {
    out.bundle = { icon: brand.icons };
  }
  return out;
}

/** The Rust constants, escaped for a Rust string literal. */
export function rustSource(brand: Brand): string {
  // A newline in a name would end the literal and turn the build into a
  // confusing syntax error in generated code; control characters are escaped
  // so a bad value shows up as a Rust string, not as a broken file.
  const escape = (value: string) =>
    value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
  return `// Generated by scripts/brand.ts. Do not edit; run \`bun run brand\` instead.
pub const PRODUCT_NAME: &str = "${escape(brand.productName)}";
pub const IDENTIFIER: &str = "${escape(brand.identifier)}";
pub const DATA_DIR: &str = "${escape(brand.dataDir)}";
pub const SOURCE_URL: &str = "${escape(brand.sourceUrl)}";
pub const SOURCE_LABEL: &str = "${escape(brand.sourceLabel)}";
`;
}

/** Remove whatever a previous run wrote. */
export function cleanGenerated(): void {
  for (const path of [overlayPath, rustPath]) {
    if (existsSync(path)) rmSync(path);
  }
}

/**
 * Write the overlay and the Rust constants.
 *
 * Returns the paths written, empty when the brand is the upstream one: a plain
 * build should leave the tree as it found it, and the committed defaults in
 * `tauri.conf.json` and `brand.rs` already say the upstream name.
 */
export function writeBrand(brand: Brand): string[] {
  if (!isCustom(brand)) {
    cleanGenerated();
    return [];
  }
  mkdirSync(dirname(overlayPath), { recursive: true });
  writeFileSync(overlayPath, `${JSON.stringify(overlay(brand), null, 2)}\n`);
  writeFileSync(rustPath, rustSource(brand));
  return [overlayPath, rustPath];
}

/** A starter `brand.local.ts`, so a fork begins from a working example. */
function scaffold(): string {
  return `// This file is yours. \`.gitignore\` excludes it, so it never reaches upstream
// and every upstream commit keeps applying to your fork without a conflict.
//
// \`bun run brand\` reads the presets below; \`STRATA_BRAND=<name>\` selects one.
// \`STRATA_BRAND_NAME\` and friends override a single field without restating
// the rest.

export const PRESETS = {
  company: {
    productName: "Company Agent",
    identifier: "com.company.agent",
    // A folder of its own, so this build and the upstream one can live on the
    // same machine without sharing a database, a token or a pid table.
    dataDir: ".company-agent",
    sourceUrl: "https://github.com/your-org/your-fork",
    sourceLabel: "your-org/your-fork",
    // Optional: a bundled icon set, relative to apps/desktop/src-tauri.
    // Leave it out to keep the upstream marks.
    // icons: [
    //   "icons/company/32x32.png",
    //   "icons/company/128x128.png",
    //   "icons/company/128x128@2x.png",
    //   "icons/company/icon.icns",
    //   "icons/company/icon.ico",
    // ],
  },
};
`;
}

// Run as a script (not imported by a test).
if (import.meta.main) {
  const argv = Bun.argv.slice(2);
  if (argv.includes("--clean")) {
    cleanGenerated();
    console.log("brand: removed the generated files");
    process.exit(0);
  }
  if (argv.includes("--scaffold")) {
    if (existsSync(localPath)) {
      console.log(`brand: ${localPath} already exists; leaving it alone`);
      process.exit(0);
    }
    writeFileSync(localPath, scaffold());
    console.log(`brand: wrote ${localPath.replace(root + "/", "")}`);
    process.exit(0);
  }
  const brand = await resolveBrand();
  if (argv.includes("--print")) {
    console.log(JSON.stringify({ brand, custom: isCustom(brand) }, null, 2));
    process.exit(0);
  }
  const written = writeBrand(brand);
  if (written.length === 0) {
    console.log(`brand: ${brand.productName} (upstream; nothing to generate)`);
  } else {
    console.log(
      `brand: ${brand.productName} -> ${written.map((p) => p.replace(root + "/", "")).join(", ")}`,
    );
  }
}
