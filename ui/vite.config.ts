import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Bundles the `ah ui` frontend into `ui/dist` (docs/web-ui.md). `npm run build:ui`
// runs this from the repo root (`vite build ui`); dev proxy targets the `ah ui` server
// default port (4180) so `vite dev` can run against a live receiver without CORS.
// `__APP_VERSION__` (src/env.d.ts) is the root package.json's version: the dist ships inside
// that same package, so the app bar needs no server or contract change to show it.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4180",
    },
  },
});
