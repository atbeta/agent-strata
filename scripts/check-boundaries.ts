// Package boundary check.
//
// Workspace packages are reached by name (@agent-strata/*), and a package's
// "exports" map is the whole of what may be reached. This script enforces
// the two halves of that rule oxlint cannot see:
//
// - A relative specifier may not cross into another package. The pattern in
//   .oxlintrc.json only sees specifiers that literally spell "packages/"; a
//   hop like "../../schema/src/index" bypasses the exports map without ever
//   writing the word. Here the specifier is resolved and the package that
//   owns each side is compared, so every relative crossing is caught.
// - An @agent-strata/* import must be declared in the importer's
//   package.json, and the subpath must exist in the target's exports map. A
//   name that resolves only because node_modules happens to hold the package
//   is an undeclared edge, which is what the boundary exists to prevent.
//
// Only import specifiers are read. Filesystem paths are a different thing:
// the bench spawns the service and a mock agent at ../packages/... paths
// built with join(), and path-link.test.ts carries such a path as test
// data. Neither is an import, and neither is flagged.
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = join(import.meta.dir, "..");

/**
 * Relative specifiers that may cross a package boundary anyway, keyed by the
 * importing file (repo-relative) with the resolved targets it may reach. An
 * entry here is a deliberate exception — adding one is part of the review.
 */
const allowedCrossings = new Map<string, Set<string>>([
  // vite.config.ts is bundler configuration, not package code. It has to
  // resolve the brand before any UI module runs (the value becomes the
  // __BRAND__ define), and the resolver lives in the root package's
  // scripts/ — which has no package.json of its own to import by name.
  // app-name.test.ts is that resolver's contract test: it exists to keep the
  // injected brand and the page's fallback from drifting apart, so it has to
  // reach the same file the bundler does.
  ["apps/desktop/ui/vite.config.ts", new Set(["scripts/brand.ts"])],
  ["apps/desktop/ui/src/app-name.test.ts", new Set(["scripts/brand.ts"])],
]);

const scannedDirs = ["apps", "packages", "scripts"];
const skipped = /(?:^|\/)(?:node_modules|dist|\.cache|\.git|results)\//;

/** name (e.g. @agent-strata/store) -> absolute package directory. */
const workspacePackages = new Map<string, string>();
const readJson = (path: string) => Bun.file(path).json() as Promise<Record<string, unknown>>;

const rootPkg = await readJson(join(root, "package.json"));
for (const pattern of (rootPkg.workspaces as string[] | undefined) ?? []) {
  const parent = join(root, pattern.replace(/\/\*$/, ""));
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(parent, entry.name, "package.json");
    if (!existsSync(manifest)) continue;
    const name = (await readJson(manifest)).name;
    if (typeof name === "string") workspacePackages.set(name, join(parent, entry.name));
  }
}

/** The directory holding the nearest package.json at or above `path`. */
const pkgDirCache = new Map<string, string>();
const packageDirOf = (path: string): string => {
  let dir = dirname(path);
  for (;;) {
    const hit = pkgDirCache.get(dir);
    if (hit) return hit;
    if (existsSync(join(dir, "package.json"))) {
      pkgDirCache.set(dir, dir);
      return dir;
    }
    const up = dirname(dir);
    if (up === dir) return root;
    dir = up;
  }
};

const extensions = [".ts", ".tsx", ".d.ts", ".json", "/index.ts", "/index.tsx"];
const resolveSpecifier = (importer: string, specifier: string): string | null => {
  const base = resolve(dirname(importer), specifier);
  for (const ext of ["", ...extensions]) {
    if (existsSync(base + ext)) return base + ext;
  }
  return null;
};

/** import/export specifiers: `from "x"`, `import "x"`, `import("x")`. */
const specifierPattern = /(?:\bfrom|\bimport)\s*\(?\s*["']([^"'\n]+)["']/g;

const declaredIn = (manifest: Record<string, unknown>, name: string): boolean =>
  ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].some(
    (field) => typeof manifest[field] === "object" && manifest[field] !== null && name in (manifest[field] as object),
  );

const violations: string[] = [];
const report = (file: string, index: number, content: string, message: string) => {
  const line = content.slice(0, index).split("\n").length;
  violations.push(`${file}:${line}: ${message}`);
};

for (const top of scannedDirs) {
  for await (const rel of new Bun.Glob("**/*").scan({ cwd: join(root, top), onlyFiles: true })) {
    if (skipped.test(rel) || !/\.tsx?$/.test(rel)) continue;
    const relPath = `${top}/${rel}`;
    const file = join(root, relPath);
    const content = await Bun.file(file).text();
    const importerPkg = packageDirOf(file);
    for (const match of content.matchAll(specifierPattern)) {
      const specifier = match[1];
      const at = match.index + match[0].indexOf(specifier);
      if (specifier.startsWith(".")) {
        const target = resolveSpecifier(file, specifier);
        if (!target) continue; // tsc reports unresolvable imports itself
        if (packageDirOf(target) === importerPkg) continue;
        const targetRel = relative(root, target);
        if (allowedCrossings.get(relPath)?.has(targetRel)) continue;
        report(relPath, at, content, `"${specifier}" crosses into ${relative(root, packageDirOf(target)) || "."} (${targetRel}) — import by package name instead`);
        continue;
      }
      if (!specifier.startsWith("@agent-strata/")) continue;
      const [, name, subpath] = specifier.match(/^(@agent-strata\/[^/]+)(?:\/(.+))?$/) ?? [];
      if (!name) continue;
      const manifest = (await readJson(join(importerPkg, "package.json"))) as Record<string, unknown>;
      if (!declaredIn(manifest, name)) {
        report(relPath, at, content, `"${specifier}" is not declared in ${relative(root, importerPkg) || "."}/package.json`);
        continue;
      }
      const targetPkg = workspacePackages.get(name);
      if (!targetPkg) continue; // not a workspace package; nothing more to check
      const targetManifest = await readJson(join(targetPkg, "package.json"));
      const exportsMap = targetManifest.exports;
      const key = subpath ? `./${subpath}` : ".";
      const reachable =
        typeof exportsMap === "object" && exportsMap !== null && key in (exportsMap as object);
      if (!reachable) {
        report(relPath, at, content, `"${specifier}" is not in the exports map of ${name} (${key})`);
      }
    }
  }
}

if (violations.length) {
  console.error(violations.join("\n"));
  console.error(`\nBoundary check failed: ${violations.length} import(s) bypass a package boundary.`);
  process.exit(1);
}
console.log("boundary check passed");
