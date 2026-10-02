import { defineConfig } from "vite";

// Builds the Electron side (electron/main.ts and electron/preload.ts) into dist/electron/.
//
// Why bundle it instead of compiling it with tsc like the API? The main process uses
// @circuitlab/engine and @circuitlab/netlist. In this repo they are workspace links in
// node_modules, but the installed app has no repo around it. Bundled, main.js carries their code
// inside it, so the installed app needs no node_modules at all.
export default defineConfig({
  publicDir: false, // the window's files (public/) belong to the window, not here
  build: {
    ssr: true, // build for Node.js, not for a browser
    target: "node24", // the Node.js inside Electron 44
    outDir: "dist/electron",
    emptyOutDir: true,
    sourcemap: true,
    minify: false, // readable stack traces
    rolldownOptions: {
      input: { main: "electron/main.ts", preload: "electron/preload.ts" },
      // Electron provides these at run time; everything else is bundled.
      external: ["electron", /^node:/],
      output: { format: "cjs", entryFileNames: "[name].js" },
    },
  },
  ssr: { noExternal: true }, // bundle our packages too (Vite leaves dependencies out by default)
});
