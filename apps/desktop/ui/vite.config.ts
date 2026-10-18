import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";

const service = process.env.STRATA_SERVICE_URL ?? "http://127.0.0.1:7700";

/**
 * The About tab has to name the build it is running in, and `tauri.conf.json`
 * is the one file that decides what that build is called — Cargo and the UI
 * package.json both copy it. Reading it here rather than asking Tauri for
 * `getVersion()` keeps the version a plain constant: the panel renders in a
 * browser tab during development too, instead of only inside the shell.
 */
const version = (() => {
  try {
    const conf = JSON.parse(
      readFileSync(fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url)), "utf8"),
    ) as { version?: string };
    return conf.version ?? "0.0.0";
  } catch {
    // A missing or malformed config should break the bundle loudly in review,
    // not silently ship a panel that claims to be some other build.
    return "0.0.0";
  }
})();

export default defineConfig({
  plugins: [tailwindcss(), solid()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5178,
    fs: {
      allow: [fileURLToPath(new URL("../../..", import.meta.url))],
    },
    proxy: {
      "/api": {
        target: service,
        ws: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
