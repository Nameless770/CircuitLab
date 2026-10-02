// `npm run dev:desktop`: starts Vite's dev server for the window's code, then opens Electron
// on it. Edits to the window's code (src/) show up at once (hot reload); edits to the main
// process (electron/) need a restart: close the app and run the command again.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron"; // in Node, the "electron" package is just the path of the program
import { createServer } from "vite";

// path.resolve drops the trailing slash: on Windows, a path ending in "\" would escape the quote around it.
const appDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const server = await createServer({ root: appDir, configFile: fileURLToPath(new URL("../vite.config.mts", import.meta.url)) });
await server.listen();
const url = server.resolvedUrls?.local[0] ?? "http://localhost:5173/";
console.log(`Vite dev server: ${url}`);

const electron = spawn(String(electronPath), [appDir], {
  stdio: "inherit",
  env: { ...process.env, CIRCUITLAB_DEV_SERVER_URL: url },
});
electron.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
