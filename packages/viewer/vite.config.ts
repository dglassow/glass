import { defineConfig } from "vite";

/**
 * The Viewer is a plain Vite app. In development it runs standalone
 * (`pnpm --filter @glass/viewer dev`); in production the same bundle is served
 * inside the Tauri desktop shell and, later, by the Hub as the mobile PWA.
 */
export default defineConfig({
  root: ".",
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
