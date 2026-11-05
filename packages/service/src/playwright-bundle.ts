/**
 * playwright-core reads its own package.json with a dynamic require on purpose,
 * so the bundler that builds playwright itself will not inline it:
 *
 *   packageRoot = path.join(__dirname, "..");
 *   packageJSON = require(path.join(packageRoot, "package.json"));
 *
 * `bun build --compile` keeps `__dirname` as the path of the file on the
 * machine that compiled the sidecar. A binary built on the Windows runner then
 * asks for `D:\a\agent-strata\...\playwright-core\package.json` on every other
 * machine, and that require runs while the module is evaluated — the service
 * process exits before it listens. The registry does the same with
 * browsers.json the first time a browser is launched.
 *
 * Both reads are rewritten to literals here. The esbuild helper names
 * (`import_path8` and friends) change between playwright releases, so the
 * match is on the call shape, and a miss fails the sidecar build instead of
 * shipping another binary that only runs where it was compiled.
 */
import { dirname, join } from "node:path";
import type { BunPlugin } from "bun";

const PACKAGE_JSON_REQUIRE =
  /packageJSON = require\([^;]*?join\(packageRoot, "package\.json"\)\);/;

const BROWSERS_JSON_REQUIRE =
  /new Registry\(require\([^;]*?join\(packageRoot, "browsers\.json"\)\)\)/;

export function patchPlaywrightCoreBundle(
  source: string,
  packageJSON: { name?: string; version?: string },
  browsersJSON: string,
): string {
  if (!packageJSON.version) {
    throw new Error("playwright-core package.json has no version to embed");
  }
  JSON.parse(browsersJSON);
  const version = packageJSON.version;
  const pkgLiteral = JSON.stringify(JSON.stringify({ name: packageJSON.name, version }));
  const browsersLiteral = JSON.stringify(browsersJSON);

  const withPackage = source.replace(PACKAGE_JSON_REQUIRE, () => `packageJSON = JSON.parse(${pkgLiteral});`);
  if (withPackage === source) {
    throw new Error(
      "playwright-core no longer reads package.json via packageRoot; " +
        "the compiled sidecar would crash on any machine but the one that built it",
    );
  }
  const withBrowsers = withPackage.replace(
    BROWSERS_JSON_REQUIRE,
    () => `new Registry(JSON.parse(${browsersLiteral}))`,
  );
  if (withBrowsers === withPackage) {
    throw new Error(
      "playwright-core no longer reads browsers.json via packageRoot; " +
        "the compiled sidecar would crash when a browser is launched",
    );
  }
  if (withBrowsers.includes('join(packageRoot, "package.json")')) {
    throw new Error("playwright-core still requires package.json after the sidecar rewrite");
  }
  if (withBrowsers.includes('join(packageRoot, "browsers.json")')) {
    throw new Error("playwright-core still requires browsers.json after the sidecar rewrite");
  }
  if (!withBrowsers.includes(version)) {
    throw new Error("embedded playwright version did not land in the bundle");
  }
  return withBrowsers;
}

/** Rewrite playwright-core's prebuilt bundle while the sidecar is compiled. */
export const playwrightCorePlugin: BunPlugin = {
  name: "playwright-core-embed",
  setup(build) {
    build.onLoad({ filter: /[/\\]playwright-core[/\\]lib[/\\]coreBundle\.js$/ }, async (args) => {
      const packageRoot = dirname(dirname(args.path));
      const source = await Bun.file(args.path).text();
      const packageJSON = (await Bun.file(join(packageRoot, "package.json")).json()) as {
        name?: string;
        version?: string;
      };
      const browsersJSON = await Bun.file(join(packageRoot, "browsers.json")).text();
      return {
        contents: patchPlaywrightCoreBundle(source, packageJSON, browsersJSON),
        loader: "js",
      };
    });
  },
};
