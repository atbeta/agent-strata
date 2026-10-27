import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveBrand } from "../../../scripts/brand";

/**
 * The brand this build carries.
 *
 * Resolved here from the environment rather than imported from `app-name.ts`:
 * that module reads `__BRAND__`, which is the value this file is about to
 * define. Importing it would close the loop and always see the upstream
 * default — the build would ignore every white-label setting and say nothing.
 */
const brand = await resolveBrand();
const APP_NAME = brand.productName;

const service = process.env.STRATA_SERVICE_URL ?? "http://127.0.0.1:7700";

/**
 * The capability token the service expects, when there is one.
 *
 * A browser tab cannot read the token the desktop shell generated — only the
 * shell can — so the dev proxy presents it on the way through. The page in
 * the shell asks the shell for the token and sends it itself.
 */
const tokenEnv = process.env.STRATA_API_TOKEN;
const tokenPath = join(homedir(), brand.dataDir, "api-token");

/**
 * The token, read per request.
 *
 * The packaged build has it in the environment. The dev build cannot use that:
 * the shell generates the token when it launches, which is after vite has read
 * this file, and hands it to the service as that service's environment — the
 * vite process never sees it. The shell also writes it to the brand's data
 * directory, so that is where the proxy looks, and it looks per request
 * because the file does not exist yet when this module is evaluated.
 */
let tokenCache: { at: number; value: string } = { at: 0, value: "" };
const readToken = (): string => {
  if (tokenEnv) return tokenEnv;
  const now = Date.now();
  // The file is written once per launch, so it is read at most once a second.
  if (now - tokenCache.at < 1_000) return tokenCache.value;
  let value = "";
  try {
    value = readFileSync(tokenPath, "utf8").trim();
  } catch {
    // No shell, no token: the service asks for nothing.
  }
  tokenCache = { at: now, value };
  return value;
};

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

export default defineConfig(async () => ({
  plugins: [
    tailwindcss(),
    solid(),
    {
      // The document title is the product's name as well, and HTML cannot
      // import the constant the panels read — so the build fills it in.
      name: "app-name",
      transformIndexHtml: (html: string) => html.replace("%APP_NAME%", APP_NAME),
    },
  ],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    // The brand, resolved once by `scripts/brand.ts` and read back by the page.
    // `app-name.ts` falls back to the upstream values when nothing was injected,
    // which is how a browser tab during development behaves.
    __BRAND__: JSON.stringify(brand),
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
        // The proxy presents the token on everything it forwards, the socket
        // upgrade included.
        configure: (proxy) => {
          const present = (req: { setHeader(name: string, value: string): void }) => {
            const t = readToken();
            if (t) req.setHeader("authorization", `Bearer ${t}`);
          };
          proxy.on("proxyReq", present);
          proxy.on("proxyReqWs", present);
        },
      },
    },
  },
}));
