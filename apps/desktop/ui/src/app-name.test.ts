import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_NAME, UPSTREAM } from "./app-name";
import { resolveBrand } from "../../../../scripts/brand";

/**
 * The packaged build and the panels have to call the same thing the same way.
 *
 * Both come from one place: `scripts/brand.ts` resolves the brand from the
 * environment, `tauri build --config` merges the overlay it writes, and
 * `vite.config.ts` injects the same answer into the page. Nothing here may hold
 * a second copy of a name — a rename that reached one side and not the other
 * would show two names in the same window.
 *
 * A test process has no injected `__BRAND__`, so `APP_NAME` is the upstream
 * default. That is exactly the invariant the committed config has to satisfy:
 * `tauri.conf.json` is the upstream build, and a white-label build overrides it
 * through the overlay rather than by editing it.
 */
const tauriDir = fileURLToPath(new URL("../../src-tauri/", import.meta.url));

const conf = JSON.parse(readFileSync(`${tauriDir}tauri.conf.json`, "utf8")) as {
  productName?: string;
  app?: { windows?: { title?: string }[] };
};

const overlayPath = `${tauriDir}brand.overlay.json`;

describe("app name", () => {
  test("the committed config carries the upstream name", () => {
    // A fork must not edit this file: the overlay is how it renames the build,
    // and an edit here would conflict on every upstream change to it.
    expect(conf.productName).toBe(UPSTREAM.productName);
  });

  test("the window opens with that name", () => {
    expect(conf.app?.windows?.[0]?.title).toBe(UPSTREAM.productName);
  });

  test("the page falls back to the upstream name", () => {
    // What a browser tab and a test process see when nothing was injected.
    expect(APP_NAME).toBe(UPSTREAM.productName);
  });

  test("the overlay, when present, is what the environment asks for", async () => {
    // `bun run brand` leaves this file behind, and a release job runs that step
    // before the build. A stale overlay — written under one `STRATA_BRAND`, then
    // built under another — would ship a name the environment no longer asks
    // for, so when the environment names a brand the file is held to a fresh
    // resolution of the same variables.
    //
    // With no brand named, a leftover overlay belongs to somebody's earlier
    // local white-label build and says nothing about this one. Failing there
    // would turn every white-label build into a red test suite afterwards, and
    // `bun run brand` removes the file anyway on the next plain build.
    if (!existsSync(overlayPath)) return;
    const named = Object.keys(process.env).some(
      (key) => key.startsWith("STRATA_BRAND") && process.env[key]?.trim(),
    );
    if (!named) return;
    const overlay = JSON.parse(readFileSync(overlayPath, "utf8")) as {
      productName?: string;
      identifier?: string;
      app?: { windows?: { title?: string }[] };
    };
    const brand = await resolveBrand();
    expect(overlay.productName).toBe(brand.productName);
    expect(overlay.identifier).toBe(brand.identifier);
    expect(overlay.app?.windows?.[0]?.title).toBe(brand.productName);
  });
});
