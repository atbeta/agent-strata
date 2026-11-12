import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

/**
 * Component tests. `bun test` cannot compile Solid JSX — the package tsconfig
 * keeps `"jsx": "preserve"` and bun has no solid transform — so components
 * mount here, under the same vite-plugin-solid pipeline the app builds with,
 * inside jsdom. Files end in `.vtest.tsx` so `bun test`'s `.test.` glob does
 * not pick them up: bun:test owns the pure-logic suite, vitest owns the DOM.
 */
export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.vtest.tsx"],
  },
});
