import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Builds the window's code into dist/renderer/ (the Electron side has vite.main.config.mts).
//
// While developing, the window still loads app://circuitlab/: electron/main.ts fetches its files
// from this dev server, and forwards /v1/... to the API itself (the address in Settings). So
// there's no proxy here: one place does the forwarding, in development and in the built app.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)), // paths below are relative to this folder, wherever Vite is run from
  // Relative paths in the built index.html, so it works from app://circuitlab/.
  base: "./",
  build: { outDir: "dist/renderer", emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    // The page's address is app://circuitlab, so hot reload must be told where this server is.
    hmr: { protocol: "ws", host: "localhost", port: 5173 },
  },
});
