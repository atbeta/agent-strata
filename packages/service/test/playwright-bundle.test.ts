import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { patchPlaywrightCoreBundle } from "../src/playwright-bundle";

const SNIPPET = `
packageJSON = require(import_path8.default.join(packageRoot, "package.json"));
registry = new Registry(require(import_path19.default.join(packageRoot, "browsers.json")));
`;

describe("playwright sidecar rewrite", () => {
  test("inlines the package manifest and the browser registry", () => {
    const out = patchPlaywrightCoreBundle(SNIPPET, { name: "playwright-core", version: "9.9.9" }, '{"browsers":[]}');
    expect(out).not.toContain('join(packageRoot, "package.json")');
    expect(out).not.toContain('join(packageRoot, "browsers.json")');
    expect(out).toContain("9.9.9");
    expect(out).toContain(JSON.stringify('{"browsers":[]}'));
  });

  test("refuses a bundle whose reads it cannot see", () => {
    expect(() => patchPlaywrightCoreBundle("untouched", { name: "playwright-core", version: "1.0.0" }, "{}")).toThrow(
      /package\.json/,
    );
  });

  test("the installed playwright-core bundle still has those two reads", () => {
    const require = createRequire(import.meta.url);
    const packageJSONPath = require.resolve("playwright-core/package.json");
    const source = readFileSync(join(dirname(packageJSONPath), "lib", "coreBundle.js"), "utf8");
    const browsers = readFileSync(join(dirname(packageJSONPath), "browsers.json"), "utf8");
    const pkg = JSON.parse(readFileSync(packageJSONPath, "utf8")) as { name: string; version: string };
    const out = patchPlaywrightCoreBundle(source, pkg, browsers);
    expect(out).toContain(pkg.version);
    expect(out).not.toContain('join(packageRoot, "package.json")');
    expect(out).not.toContain('join(packageRoot, "browsers.json")');
  });
});
