import type { LibraryCircuit, LibraryItem, LocalCircuit, OpenedFile } from "../../electron/bridge";
import { requireDesktop, unwrap } from "../desktop";
import { forgetPositions } from "../diagram/saved-positions";

/**
 * Offline mode works like Notepad: one circuit is open at a time. This module remembers which
 * one, and where it's saved:
 * - in the **library**, inside the app (the usual place: saving needs no file dialog);
 * - in a **file** the user opened (a double-clicked .net file, or File > Open);
 * - **nowhere yet**: a new circuit, or an example.
 */
export type DocumentSource =
  | { readonly kind: "library"; readonly id: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "new" };

export interface LocalDocument {
  readonly source: DocumentSource;
  /** The circuit as netlist text, for the netlist editor. For a file, exactly what it holds, comments included. */
  readonly text: string;
  readonly circuit: LocalCircuit;
  /** Library circuits only: a netlist file has no place for a description. */
  readonly description?: string;
  /** Library circuits only: when it was last saved. */
  readonly updatedAt?: string;
}

let current: LocalDocument | null = null;

const OPEN_KEY = "circuitlab.openDocument";
const RECENT_KEY = "circuitlab.recentFiles";
const MAX_RECENT = 8;

export function currentDocument(): LocalDocument | null {
  return current;
}

export function setDocument(document: LocalDocument): void {
  current = document;
  try {
    // Survives a reload of the window (Ctrl+R), not a restart of the app. A new circuit can't be
    // reopened (it's saved nowhere), so it isn't remembered.
    if (document.source.kind === "new") sessionStorage.removeItem(OPEN_KEY);
    else sessionStorage.setItem(OPEN_KEY, JSON.stringify(document.source));
  } catch {
    // storage blocked: the circuit just won't be reopened after a reload
  }
  if (document.source.kind === "file") rememberRecent(document.source.path);
}

export function closeDocument(): void {
  current = null;
  try {
    sessionStorage.removeItem(OPEN_KEY);
  } catch {
    // nothing to forget
  }
}

/** A circuit that isn't saved anywhere yet (an example), now open. */
export function openUnsaved(text: string, circuit: LocalCircuit): void {
  setDocument({ source: { kind: "new" }, text, circuit });
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

/** @throws LocalError, e.g. when it was deleted meanwhile */
export async function openFromLibrary(id: string): Promise<void> {
  setDocument(fromLibrary(unwrap(await requireDesktop().openFromLibrary(id))));
}

/**
 * Saves netlist text in the library, replacing the circuit `id` or adding a new one when `id` is
 * left out, and makes the saved circuit the open one. Nothing is saved if the text has mistakes.
 * @throws LocalError
 */
export async function saveInLibrary(text: string, description: string | undefined, id?: string): Promise<LocalDocument> {
  const saved = unwrap(
    await requireDesktop().saveToLibrary({ ...(id !== undefined && { id }), netlist: text, ...(description !== undefined && { description }) }),
  );
  const document = fromLibrary(saved);
  setDocument(document);
  return document;
}

/** Every circuit in the library, the most recently changed first. @throws LocalError */
export async function libraryItems(): Promise<readonly LibraryItem[]> {
  return unwrap(await requireDesktop().listLibrary());
}

/** @throws LocalError */
export async function deleteFromLibrary(id: string): Promise<void> {
  unwrap(await requireDesktop().deleteFromLibrary(id));
  forgetPositions(positionsKey({ kind: "library", id }));
  if (current?.source.kind === "library" && current.source.id === id) closeDocument();
}

/** After the window reloads, the open circuit is read again (from the library or its file). */
export async function restoreDocument(): Promise<LocalDocument | null> {
  if (current !== null) return current;
  let source: DocumentSource | null = null;
  try {
    source = JSON.parse(sessionStorage.getItem(OPEN_KEY) ?? "null") as DocumentSource | null;
  } catch {
    return null;
  }
  try {
    if (source?.kind === "library") await openFromLibrary(source.id);
    if (source?.kind === "file") await openPath(source.path);
  } catch {
    closeDocument(); // deleted or moved since: nothing to show
  }
  return current;
}

function fromFile(file: OpenedFile): LocalDocument {
  return { source: { kind: "file", path: file.path }, text: file.text, circuit: file.circuit };
}

function fromLibrary(saved: LibraryCircuit): LocalDocument {
  const { item } = saved;
  return {
    source: { kind: "library", id: item.id },
    text: saved.text,
    circuit: saved.circuit,
    ...(item.description !== undefined && { description: item.description }),
    updatedAt: item.updatedAt,
  };
}

/** What to call the open circuit in the top bar. */
export function documentLabel(document: LocalDocument): string {
  if (document.source.kind === "file") return fileName(document.source.path);
  if (document.source.kind === "new") return `${document.circuit.name} (not saved)`;
  return document.circuit.name;
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
export function positionsKey(source: DocumentSource): string {
  switch (source.kind) {
    case "library":
      return `library:${source.id}`;
    case "file":
      return `file:${source.path}`;
    case "new":
      return "file:unsaved";
  }
}
