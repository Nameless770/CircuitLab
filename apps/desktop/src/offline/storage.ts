import type { LibraryCircuit, LibraryItem, LibrarySaveRequest, OpenedFile } from "../../electron/bridge";
import { requireDesktop, unwrap } from "../desktop";
import { emit } from "../shell/bus";

/**
 * Where offline circuits are kept, through the main process:
 * - the **library**, inside the app (the usual place: saving needs no file dialog);
 * - **netlist files** the user opens or exports (a double-clicked .net file, or Open).
 * Every function throws a LocalError with the main process's explanation when it fails.
 */

/** Every circuit in the library, the most recently changed first. */
export async function libraryItems(): Promise<readonly LibraryItem[]> {
  return unwrap(await requireDesktop().listLibrary());
}

export async function openLibraryCircuit(id: string): Promise<LibraryCircuit> {
  return unwrap(await requireDesktop().openFromLibrary(id));
}

/** Adds a circuit to the library (no `id`) or replaces one. Nothing is saved if the netlist has mistakes. */
export async function saveLibraryCircuit(request: LibrarySaveRequest): Promise<LibraryCircuit> {
  const saved = unwrap(await requireDesktop().saveToLibrary(request));
  emit("library");
  return saved;
}

export async function deleteLibraryCircuit(id: string): Promise<void> {
  unwrap(await requireDesktop().deleteFromLibrary(id));
  emit("library");
}

/** Shows the Open dialog and reads the file. null if the user cancelled. */
export async function chooseNetlistFile(): Promise<OpenedFile | null> {
  const result = await requireDesktop().openFile();
  if (result === null) return null;
  const file = unwrap(result);
  rememberRecent(file.path);
  return file;
}

/** Reads a netlist file without a dialog (recent files, a double-clicked file). */
export async function readNetlistFile(path: string): Promise<OpenedFile> {
  const file = unwrap(await requireDesktop().readFile(path));
  rememberRecent(file.path);
  return file;
}

/** Writes netlist text to `path`, or asks where (Save As) when it's null. Resolves to the path, or null if cancelled. */
export async function writeNetlistFile(path: string | null, text: string, suggestedName: string): Promise<string | null> {
  const written = unwrap(await requireDesktop().saveFile(path, text, suggestedName));
  if (written !== null) rememberRecent(written);
  return written;
}

// ---- recent files: kept in this computer's localStorage ----------------------------------------

const RECENT_KEY = "circuitlab.recentFiles";
const MAX_RECENT = 8;

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

/** A file that was moved or deleted since: off the list. */
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
