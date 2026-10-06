import { contextBridge, ipcRenderer } from "electron";
import type { AssistantProgress, DesktopBridge, MenuCommand } from "./bridge";

/**
 * Runs in the window before its own code, with access to Electron's IPC. It exposes exactly the
 * functions in DesktopBridge as `window.circuitlab`, and nothing else: never ipcRenderer itself,
 * which would let the window send any message to the main process.
 */
const bridge: DesktopBridge = {
  getSettings: () => ipcRenderer.invoke("circuitlab:get-settings"),
  setApiUrl: (url) => ipcRenderer.invoke("circuitlab:set-api-url", url),
  takeStartupFile: () => ipcRenderer.invoke("circuitlab:take-startup-file"),
  onOpenFile: (listener) => {
    ipcRenderer.on("circuitlab:open-path", (_event, path: string) => listener(path));
  },
  openFile: () => ipcRenderer.invoke("circuitlab:open-file"),
  readFile: (path) => ipcRenderer.invoke("circuitlab:read-file", path),
  saveFile: (path, text, suggestedName) => ipcRenderer.invoke("circuitlab:save-file", path, text, suggestedName),
  parse: (text) => ipcRenderer.invoke("circuitlab:parse", text),
  toNetlist: (circuit) => ipcRenderer.invoke("circuitlab:to-netlist", circuit),
  simulate: (circuit, request) => ipcRenderer.invoke("circuitlab:simulate", circuit, request),
  truthTable: (circuit, offset, limit) => ipcRenderer.invoke("circuitlab:truth-table", circuit, offset, limit),
  exportTruthTable: (circuit, suggestedName) => ipcRenderer.invoke("circuitlab:export-truth-table", circuit, suggestedName),
  listLibrary: () => ipcRenderer.invoke("circuitlab:library-list"),
  openFromLibrary: (id) => ipcRenderer.invoke("circuitlab:library-open", id),
  saveToLibrary: (request) => ipcRenderer.invoke("circuitlab:library-save", request),
  deleteFromLibrary: (id) => ipcRenderer.invoke("circuitlab:library-delete", id),
  onMenuCommand: (listener) => {
    ipcRenderer.on("circuitlab:menu", (_event, command: MenuCommand) => listener(command));
  },
  assistantStatus: () => ipcRenderer.invoke("circuitlab:assistant-status"),
  setAssistant: (change) => ipcRenderer.invoke("circuitlab:set-assistant", change),
  askAssistant: (request) => ipcRenderer.invoke("circuitlab:assistant-ask", request),
  cancelAssistant: () => ipcRenderer.invoke("circuitlab:assistant-cancel"),
  onAssistantProgress: (listener) => {
    ipcRenderer.on("circuitlab:assistant-progress", (_event, progress: AssistantProgress) => listener(progress));
  },
  setWindowTheme: (theme) => ipcRenderer.invoke("circuitlab:set-window-theme", theme),
};

contextBridge.exposeInMainWorld("circuitlab", bridge);
