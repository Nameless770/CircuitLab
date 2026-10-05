import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import { AssistantError, DEFAULT_OLLAMA_URL, OllamaClient, listModels } from "@circuitlab/assistant";
import { askAssistant, checkAssistant, chooseModel } from "./assistant";
import type { AppSettings, AssistantRequest, AssistantSettingsChange, CircuitData, LibrarySaveRequest, LocalResult, LocalSimulateRequest, MenuCommand, OpenedFile } from "./bridge";
import { SettingError, netlistFileFromArgs, normalizeApiUrl, normalizeOllamaUrl, readSavedSettings, type SavedSettings } from "./helpers";
import { Library } from "./library";
import * as offline from "./offline";

/**
 * The Electron main process: opens the window, owns the menu, the file dialogs and the settings,
 * forwards the window's API requests, and runs offline simulations (offline.ts). The window asks
 * for these through preload.ts.
 */

/** Online mode's server when nothing else is set: the API from `npm run start:api`. */
const DEFAULT_API_URL = "http://localhost:3000";
/** Set for development and tests; wins over the address saved in Settings. */
const ENV_API_URL = process.env["CIRCUITLAB_API_URL"];
/** Set for tests; wins over the Ollama address saved in Settings. */
const ENV_OLLAMA_URL = process.env["CIRCUITLAB_OLLAMA_URL"];
/** Set by scripts/dev.mjs while developing: the window's files then come from Vite (hot reload). */
const DEV_SERVER_URL = process.env["CIRCUITLAB_DEV_SERVER_URL"];
/** The built window code (vite build), next to this file's folder: dist/renderer. */
const RENDERER_DIR = path.join(__dirname, "..", "renderer");
/** Netlist files bigger than this are refused: a real circuit is far smaller, and reading huge files would freeze the app. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

// Where the app keeps its data (sign-in, recent files, settings). The smoke test points this at a
// throwaway folder, so it never touches your real profile.
const userDataDir = process.env["CIRCUITLAB_USER_DATA_DIR"];
if (userDataDir !== undefined) app.setPath("userData", userDataDir);

// Our own URL scheme, app://circuitlab/..., where the window's page always comes from. It has to
// be registered before the app is ready. "standard" and "secure" make it behave like https
// (fetch, localStorage).
protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let mainWindow: BrowserWindow | null = null;

/** Offline circuits saved inside the app (library.ts). Created once the app's data folder is known. */
let library: Library;

/** The .net file the app was started with (double-clicked in Explorer), until the window takes it. */
let startupFile = netlistFileFromArgs(process.argv);

// One CircuitLab at a time. Double-clicking a .net file while CircuitLab is open starts a second
// copy, which finds the first one running, hands it the file ("second-instance") and quits.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const file = netlistFileFromArgs(argv);
    if (file !== null) mainWindow.webContents.send("circuitlab:open-path", file);
  });

  void app.whenReady().then(() => {
    loadSettings();
    library = new Library(path.join(app.getPath("userData"), "library"));
    protocol.handle("app", serveApp);
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
}

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
    if (!url.startsWith("app://circuitlab/")) event.preventDefault();
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
  void window.loadURL("app://circuitlab/index.html");
  mainWindow = window;
}

// ---------------------------------------------------------------------------------------------
// Settings: online mode's server address, and the assistant's Ollama address and model, saved in
// settings.json in the app's data folder

let saved: SavedSettings = {};

function settingsFile(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function loadSettings(): void {
  try {
    saved = readSavedSettings(JSON.parse(readFileSync(settingsFile(), "utf8")));
  } catch {
    saved = {}; // no settings yet, or a damaged file: use the defaults
  }
}

async function writeSettings(): Promise<void> {
  await mkdir(path.dirname(settingsFile()), { recursive: true });
  await writeFile(settingsFile(), `${JSON.stringify(saved, null, 2)}\n`, "utf8");
}

/** The API address in use: CIRCUITLAB_API_URL if set, else the saved one, else the default. */
function apiUrl(): string {
  if (ENV_API_URL !== undefined) return ENV_API_URL.replace(/\/+$/, "");
  return saved.apiUrl ?? DEFAULT_API_URL;
}

/** Where Ollama is: the address from the environment if it's set, else the saved one, else the default. */
function assistantUrl(): string {
  if (ENV_OLLAMA_URL !== undefined) return ENV_OLLAMA_URL.replace(/\/+$/, "");
  return saved.assistantUrl ?? DEFAULT_OLLAMA_URL;
}

function currentSettings(): AppSettings {
  return {
    apiUrl: apiUrl(),
    savedApiUrl: saved.apiUrl ?? null,
    defaultApiUrl: DEFAULT_API_URL,
    fromEnvironment: ENV_API_URL !== undefined,
    assistant: {
      url: assistantUrl(),
      savedUrl: saved.assistantUrl ?? null,
      defaultUrl: DEFAULT_OLLAMA_URL,
      fromEnvironment: ENV_OLLAMA_URL !== undefined,
      savedModel: saved.assistantModel ?? null,
    },
  };
}

/** @throws SettingError for an address that can't be used */
async function saveApiUrl(text: string | null): Promise<AppSettings> {
  const { apiUrl: _replaced, ...rest } = saved; // the assistant's settings stay as they are
  saved = text === null ? rest : { ...rest, apiUrl: normalizeApiUrl(text) };
  await writeSettings();
  return currentSettings();
}

/** @throws SettingError for an address or a model name that can't be used */
async function saveAssistant(change: AssistantSettingsChange): Promise<AppSettings> {
  const { assistantUrl: oldUrl, assistantModel: oldModel, ...rest } = saved;
  const url = change.url === undefined ? oldUrl : change.url === null ? undefined : normalizeOllamaUrl(change.url);
  let model = oldModel;
  if (change.model !== undefined) {
    if (change.model !== null && (change.model.trim() === "" || change.model.length > 200)) throw new SettingError("That isn't a model name.");
    model = change.model === null ? undefined : change.model.trim();
  }
  saved = { ...rest, ...(url !== undefined && { assistantUrl: url }), ...(model !== undefined && { assistantModel: model }) };
  await writeSettings();
  return currentSettings();
}

// ---------------------------------------------------------------------------------------------
// app://circuitlab/... : the window's files, plus the API

/**
 * Everything the window loads goes through here:
 * - `/v1/...` and `/health` are forwarded to the API (the address in Settings), so the window
 *   always calls "/v1/..." and never needs CORS;
 * - everything else is the window's own files: from Vite's dev server while developing (so hot
 *   reload works), or from dist/renderer in the built app.
 */
async function serveApp(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/v1/") || url.pathname === "/health") return forwardToApi(request, url);
  if (DEV_SERVER_URL !== undefined) return fetch(new URL(`${url.pathname}${url.search}`, DEV_SERVER_URL));

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
  const server = apiUrl();
  try {
    return await fetch(`${server}${url.pathname}${url.search}`, {
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
        detail: `Can't reach the CircuitLab API at ${server}. Is it running? Check the address in Settings.`,
      }),
      { status: 503, headers: { "Content-Type": "application/problem+json" } },
    );
  }
}

// ---------------------------------------------------------------------------------------------
// What the window may ask for (see bridge.ts)

function registerIpcHandlers(): void {
  ipcMain.handle("circuitlab:get-settings", () => currentSettings());

  ipcMain.handle("circuitlab:set-api-url", (_event, text: unknown) => attempt(() => saveApiUrl(typeof text === "string" ? text : null)));

  ipcMain.handle("circuitlab:set-assistant", (_event, change: unknown) => attempt(() => saveAssistant(assistantChange(change))));

  ipcMain.handle("circuitlab:assistant-status", () => checkAssistant(assistantUrl(), saved.assistantModel ?? null));

  ipcMain.handle("circuitlab:assistant-cancel", () => {
    assistantJob?.abort();
  });

  ipcMain.handle("circuitlab:assistant-ask", (event, request: unknown) =>
    attempt(async () => {
      const asked = assistantRequest(request);
      assistantJob?.abort(); // one question at a time
      const job = new AbortController();
      assistantJob = job;
      try {
        const url = assistantUrl();
        const installed = await listModels(url, job.signal);
        const chosen = chooseModel(installed.map((model) => model.name), saved.assistantModel ?? null);
        if (chosen.model === null) throw new AssistantError("model-not-found", chosen.problem ?? "Ollama has no models.");
        return await askAssistant(new OllamaClient({ model: chosen.model, baseUrl: url }), asked, {
          signal: job.signal,
          onProgress: (progress) => {
            if (!event.sender.isDestroyed()) event.sender.send("circuitlab:assistant-progress", progress);
          },
        });
      } finally {
        if (assistantJob === job) assistantJob = null;
      }
    }),
  );

  ipcMain.handle("circuitlab:take-startup-file", () => {
    const file = startupFile;
    startupFile = null; // only once: a reload of the window mustn't open it again
    return file;
  });

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

  ipcMain.handle("circuitlab:library-list", () => attempt(() => library.list()));

  ipcMain.handle("circuitlab:library-open", (_event, id: unknown) => attempt(() => library.open(String(id))));

  ipcMain.handle("circuitlab:library-save", (_event, request: LibrarySaveRequest) => attempt(() => library.save(request)));

  ipcMain.handle("circuitlab:library-delete", (_event, id: unknown) =>
    attempt(async () => {
      await library.delete(String(id));
      return null;
    }),
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

/** The question being worked on, so that Cancel can stop it. */
let assistantJob: AbortController | null = null;

/** What the window sends is checked like anything else that comes from it. */
function assistantRequest(value: unknown): AssistantRequest {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  if (typeof record["request"] !== "string") throw new SettingError("Write what circuit you want first.");
  const netlist = record["netlist"];
  return { request: record["request"], ...(typeof netlist === "string" && { netlist }) };
}

function assistantChange(value: unknown): AssistantSettingsChange {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const part = (key: string): string | null | undefined => {
    const entry = record[key];
    return typeof entry === "string" || entry === null ? entry : undefined;
  };
  const url = part("url");
  const model = part("model");
  return { ...(url !== undefined && { url }), ...(model !== undefined && { model }) };
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
        { label: "Library", accelerator: "CmdOrCtrl+L", click: send("library") },
        { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: send("settings") },
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
