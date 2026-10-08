import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";

const service = process.env.STRATA_SERVICE_URL ?? "http://127.0.0.1:7700";

export default defineConfig({
  plugins: [tailwindcss(), solid()],
  server: {
    port: 5178,
    proxy: {
      "/api": {
        target: service,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
