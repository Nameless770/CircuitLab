import { defineConfig } from "vite";

// Where the API runs (npm run start:api). The main process reads the same variable.
const apiUrl = process.env["CIRCUITLAB_API_URL"] ?? "http://localhost:3000";

// During development the window loads this dev server, which forwards /v1/... and /health to
// the API. So the window's code always calls "/v1/..." (in the built app, electron/main.ts does
// the forwarding instead), and there's no CORS to set up on the API.
const proxy = {
  "/v1": apiUrl,
  "/health": apiUrl,
};

export default defineConfig({
  // Relative paths in the built index.html, so it also works from app://circuitlab/.
  base: "./",
  build: { outDir: "dist/renderer", emptyOutDir: true },
  server: { port: 5173, strictPort: true, proxy },
  preview: { port: 4173, proxy },
});
