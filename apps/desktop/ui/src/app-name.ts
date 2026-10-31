/**
 * The name this build calls itself.
 *
 * Every surface that states the product — the caption bar, the window title,
 * the About panel, the diagnostics header — reads it from here, so a rename is
 * one edit instead of a hunt through copy that has to be rediscovered by grep
 * and that nobody remembers to update.
 *
 * A white-label build changes it at build time, not in this file: `scripts/brand.ts`
 * resolves the brand from the environment and `vite.config.ts` hands the answer
 * in as `__BRAND__`. The constant below is what that resolves to for a plain
 * build, and `app-name.test.ts` holds it to `tauri.conf.json` so the packaged
 * name and the panels cannot drift apart.
 *
 * `src-tauri/tauri.conf.json` is the packaged side of the same name: it is what
 * the installer lists and what the shell titles its window with. For a
 * white-label build, `scripts/brand.ts` writes an overlay that both this build
 * and that config read, so the two are renamed together.
 */
export type Brand = {
  productName: string;
  identifier: string;
  dataDir: string;
  sourceUrl: string;
  sourceLabel: string;
  /** About row title. Absent: the page uses its translated "Source" line. */
  sourceTitle?: string;
  /** The sentence under that title. Absent: the translated sentence. */
  sourceHint?: string;
};

// A bare `__BRAND__`, not `globalThis.__BRAND__`: Vite's `define` rewrites an
// identifier, and a member expression is not one — the object would survive
// into the bundle unsubstituted and the page would fall back to the upstream
// name while the window title, which is computed separately in `vite.config.ts`,
// carried the brand. Two names in one window was the bug.
//
// `typeof` is safe on an identifier that was never defined, so a browser tab and
// a test process both reach the fallback instead of a ReferenceError.
const injected: Brand | undefined = typeof __BRAND__ === "undefined" ? undefined : __BRAND__;

/** The upstream build. Every field is what the app has always been. */
export const UPSTREAM: Brand = {
  productName: "Agent Strata",
  identifier: "me.pbeta.agent-strata",
  dataDir: ".agent-strata",
  sourceUrl: "https://github.com/atbeta/agent-strata",
  sourceLabel: "atbeta/agent-strata",
};

/**
 * The brand this build carries.
 *
 * A browser tab during development has no injected value — the Vite plugin that
 * defines it only runs for a real build — so the upstream name is the fallback
 * there rather than an undefined in the middle of a title.
 */
export const BRAND: Brand = injected ?? UPSTREAM;

export const APP_NAME = BRAND.productName;

/** Where the About row's link goes. Empty: the row has no link. */
export const SOURCE_URL = BRAND.sourceUrl;

/** The words on that link. */
export const SOURCE_LABEL = BRAND.sourceLabel;

/** About row title, when this build replaces the translated one. */
export const SOURCE_TITLE = BRAND.sourceTitle ?? "";

/** The sentence under that title, when this build replaces the translated one. */
export const SOURCE_HINT = BRAND.sourceHint ?? "";
