/** Injected by vite.config.ts from `src-tauri/tauri.conf.json` — see `define`. */
declare const __APP_VERSION__: string;

/**
 * Injected by vite.config.ts from `scripts/brand.ts` — see `define`.
 *
 * Absent in a browser tab during development, where the Vite plugin does not
 * run; `app-name.ts` reads it through `globalThis` and falls back to the
 * upstream values.
 */
declare const __BRAND__:
  | {
      productName: string;
      identifier: string;
      dataDir: string;
      sourceUrl: string;
      sourceLabel: string;
    }
  | undefined;
