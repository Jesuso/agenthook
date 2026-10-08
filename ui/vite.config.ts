import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Bundles the `ah ui` frontend into `ui/dist` (docs/web-ui.md). `npm run build:ui`
// runs this from the repo root (`vite build ui`); dev proxy targets the `ah ui` server
// default port (4180) so `vite dev` can run against a live receiver without CORS.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss()],
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
