import type { LocalCircuit, OpenedFile } from "../../electron/bridge";
import { requireDesktop, unwrap } from "../desktop";

/**
 * Offline mode works like Notepad: one netlist file is open at a time. This module remembers
 * which one, and the recently opened files.
 */
export interface LocalDocument {
  /** Where it's saved; null for a new circuit or an example that hasn't been saved yet. */
  readonly path: string | null;
  /** The file's text exactly as saved (comments included), for the netlist text editor. */
  readonly text: string;
  readonly circuit: LocalCircuit;
}

let current: LocalDocument | null = null;

const RECENT_KEY = "circuitlab.recentFiles";
const OPEN_FILE_KEY = "circuitlab.openFile";
const MAX_RECENT = 8;

export function currentDocument(): LocalDocument | null {
  return current;
}

export function setDocument(document: LocalDocument): void {
  current = document;
  try {
    // Survives a reload of the window (Ctrl+R), not a restart of the app.
    if (document.path === null) sessionStorage.removeItem(OPEN_FILE_KEY);
    else sessionStorage.setItem(OPEN_FILE_KEY, document.path);
  } catch {
    // storage blocked: the file just won't be reopened after a reload
  }
  if (document.path !== null) rememberRecent(document.path);
}

export function closeDocument(): void {
  current = null;
  try {
    sessionStorage.removeItem(OPEN_FILE_KEY);
  } catch {
    // nothing to forget
  }
}

/** Shows the Open dialog. Resolves to false if the user cancelled. @throws LocalError */
export async function openWithDialog(): Promise<boolean> {
  const result = await requireDesktop().openFile();
  if (result === null) return false;
  setDocument(fromFile(unwrap(result)));
  return true;
}

/** @throws LocalError, e.g. when the file has been moved */
export async function openPath(path: string): Promise<void> {
  setDocument(fromFile(unwrap(await requireDesktop().readFile(path))));
}

/** After the window reloads, the open file is read again from disk. */
export async function restoreDocument(): Promise<LocalDocument | null> {
  if (current !== null) return current;
  let path: string | null = null;
  try {
    path = sessionStorage.getItem(OPEN_FILE_KEY);
  } catch {
    return null;
  }
  if (path === null) return null;
  try {
    await openPath(path);
  } catch {
    closeDocument();
  }
  return current;
}

function fromFile(file: OpenedFile): LocalDocument {
  return { path: file.path, text: file.text, circuit: file.circuit };
}

export function recentFiles(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecent(path: string): void {
  const list = [path, ...recentFiles().filter((item) => item !== path)].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // not remembered, that's all
  }
}

export function forgetRecent(path: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentFiles().filter((item) => item !== path)));
  } catch {
    // ignore
  }
}

/** "C:\circuits\adder.net" -> "adder.net" */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** The key the diagram's saved gate positions use (see diagram/saved-positions.ts). */
export function positionsKey(path: string | null): string {
  return `file:${path ?? "unsaved"}`;
}
