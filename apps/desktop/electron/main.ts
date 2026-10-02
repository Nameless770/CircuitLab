import { readFile, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import type { CircuitData, LocalResult, LocalSimulateRequest, MenuCommand, OpenedFile } from "./bridge";
import * as offline from "./offline";

/**
 * The Electron main process: opens the window, owns the menu and the file dialogs, and runs
 * offline simulations (offline.ts). The window asks for these through preload.ts.
 */

/** Online mode's API. Change it with CIRCUITLAB_API_URL=https://... */
const API_URL = (process.env["CIRCUITLAB_API_URL"] ?? "http://localhost:3000").replace(/\/+$/, "");
/** Set by scripts/dev.mjs while developing: the window loads Vite's dev server (hot reload). */
const DEV_SERVER_URL = process.env["CIRCUITLAB_DEV_SERVER_URL"];
/** The built window code (vite build), next to this file's folder: dist/renderer. */
const RENDERER_DIR = path.join(__dirname, "..", "renderer");
/** Netlist files bigger than this are refused: a real circuit is far smaller, and reading huge files would freeze the app. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

// Where the app keeps its data (sign-in, recent files). The smoke test points this at a
// throwaway folder, so it never touches your real profile.
const userDataDir = process.env["CIRCUITLAB_USER_DATA_DIR"];
if (userDataDir !== undefined) app.setPath("userData", userDataDir);

// Our own URL scheme, app://circuitlab/..., for the built app. It has to be registered before
// the app is ready. "standard" and "secure" make it behave like https (fetch, localStorage).
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let mainWindow: BrowserWindow | null = null;

void app.whenReady().then(() => {
  if (DEV_SERVER_URL === undefined) protocol.handle("app", serveApp);
  registerIpcHandlers();
  Menu.setApplicationMenu(buildMenu());
  createWindow();
  // macOS keeps apps running without windows; clicking the dock icon opens one again.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "CircuitLab",
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // The window shows web content, so it gets no Node.js powers: only what preload.ts exposes.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Links to websites open in the normal browser, never inside the app.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(DEV_SERVER_URL ?? "app://circuitlab/")) event.preventDefault();
  });
  // The editors cancel "beforeunload" while there are unsaved changes. A browser would then ask
  // "Leave site?"; Electron asks nothing and simply doesn't close, so we ask ourselves.
  window.webContents.on("will-prevent-unload", (event) => {
    const choice = dialog.showMessageBoxSync(window, {
      type: "question",
      buttons: ["Leave", "Stay"],
      defaultId: 1,
      cancelId: 1,
      title: "Unsaved changes",
      message: "You have unsaved changes. Leave without saving them?",
    });
    if (choice === 0) event.preventDefault(); // preventDefault here means "leave anyway"
  });
  window.on("closed", () => {
    mainWindow = null;
  });
  void window.loadURL(DEV_SERVER_URL ?? "app://circuitlab/index.html");
  mainWindow = window;
}

// ---------------------------------------------------------------------------------------------
// app://circuitlab/... : the built window code, plus the API

/**
 * In the built app, the window's code comes from app://circuitlab/. Requests for /v1/... are
 * forwarded to the API, the job Vite's proxy does during development (vite.config.mts). So the
 * window's code always calls "/v1/..." and works the same in both.
 */
async function serveApp(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/v1/") || url.pathname === "/health") return forwardToApi(request, url);

  const relative = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = path.join(RENDERER_DIR, relative);
  // Never serve anything outside the app's own folder (a path like /../../secret).
  if (path.relative(RENDERER_DIR, file).startsWith("..")) return new Response("Not found", { status: 404 });
  try {
    return await net.fetch(pathToFileURL(file).toString());
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

/** Only the headers the API needs are passed on. */
const FORWARDED_HEADERS = ["accept", "authorization", "content-type", "if-match", "if-none-match"];

async function forwardToApi(request: Request, url: URL): Promise<Response> {
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  try {
    return await fetch(`${API_URL}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
    });
  } catch {
    // Answer like the API would, so the window shows a normal error message.
    return new Response(
      JSON.stringify({
        type: "/problems/server-unavailable",
        title: "Server unavailable",
        status: 503,
        code: "server-unavailable",
        detail: `Can't reach the CircuitLab API at ${API_URL}. Is it running? (npm run start:api)`,
      }),
      { status: 503, headers: { "Content-Type": "application/problem+json" } },
    );
  }
}

// ---------------------------------------------------------------------------------------------
// What the window may ask for (see bridge.ts)

function registerIpcHandlers(): void {
  ipcMain.handle("circuitlab:api-url", () => API_URL);

  ipcMain.handle("circuitlab:open-file", async (event) => {
    const options = {
      title: "Open a netlist",
      properties: ["openFile" as const],
      filters: [
        { name: "Netlists", extensions: ["net", "txt"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const owner = windowOf(event);
    const choice = owner === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options);
    const chosen = choice.filePaths[0];
    if (choice.canceled || chosen === undefined) return null;
    return attempt(() => openFile(chosen));
  });

  ipcMain.handle("circuitlab:read-file", (_event, filePath: unknown) => attempt(() => openFile(String(filePath))));

  ipcMain.handle("circuitlab:save-file", (event, filePath: unknown, text: unknown, suggestedName: unknown) =>
    attempt(async () => {
      const target = typeof filePath === "string" ? filePath : await askWhereToSave(event, `${String(suggestedName)}.net`, "Netlists", "net");
      if (target === null) return null;
      await writeFile(target, String(text), "utf8");
      return target;
    }),
  );

  ipcMain.handle("circuitlab:parse", (_event, text: unknown) => attempt(() => offline.readNetlist(String(text), "Untitled circuit")));

  ipcMain.handle("circuitlab:to-netlist", (_event, circuit: CircuitData) => attempt(() => offline.toNetlist(circuit)));

  ipcMain.handle("circuitlab:simulate", (_event, circuit: CircuitData, request: LocalSimulateRequest) => attempt(() => offline.simulate(circuit, request)));

  ipcMain.handle("circuitlab:truth-table", (_event, circuit: CircuitData, offset: unknown, limit: unknown) =>
    attempt(() => offline.truthTablePage(circuit, Number(offset), Number(limit))),
  );

  ipcMain.handle("circuitlab:export-truth-table", (event, circuit: CircuitData, suggestedName: unknown) =>
    attempt(async () => {
      offline.checkExport(circuit); // fail before asking where to save
      const target = await askWhereToSave(event, `${String(suggestedName)}.csv`, "CSV files", "csv");
      if (target === null) return null;
      // A stream: rows are produced only as fast as the disk takes them (phase 2's idea).
      await pipeline(Readable.from(offline.truthTableCsv(circuit)), createWriteStream(target));
      return target;
    }),
  );
}

/** Runs `work` and packs the outcome for the window: a value, or the error as data. */
async function attempt<T>(work: () => T | Promise<T>): Promise<LocalResult<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    return { ok: false, problem: offline.toProblem(error) };
  }
}

async function openFile(filePath: string): Promise<OpenedFile> {
  const { size } = await stat(filePath);
  if (size > MAX_FILE_BYTES) throw new RangeError(`This file is ${(size / 1024 / 1024).toFixed(1)} MB; netlists over ${MAX_FILE_BYTES / 1024 / 1024} MB aren't opened.`);
  const text = await readFile(filePath, "utf8");
  return { path: filePath, text, circuit: offline.readNetlist(text, path.basename(filePath, path.extname(filePath))) };
}

async function askWhereToSave(event: IpcMainInvokeEvent, defaultName: string, filterName: string, extension: string): Promise<string | null> {
  const options = { defaultPath: defaultName, filters: [{ name: filterName, extensions: [extension] }] };
  const owner = windowOf(event);
  const choice = owner === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(owner, options);
  return choice.canceled || choice.filePath === undefined || choice.filePath === "" ? null : choice.filePath;
}

function windowOf(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

// ---------------------------------------------------------------------------------------------
// The menu bar

function buildMenu(): Menu {
  const send = (command: MenuCommand) => () => mainWindow?.webContents.send("circuitlab:menu", command);
  const template: MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        { label: "Home", accelerator: "CmdOrCtrl+H", click: send("home") },
        { type: "separator" },
        { label: "New Offline Circuit", accelerator: "CmdOrCtrl+N", click: send("new") },
        { label: "Open Netlist File…", accelerator: "CmdOrCtrl+O", click: send("open") },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}
