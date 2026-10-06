import type { CircuitInput, CircuitResource } from "@circuitlab/api-contract";
import type { Bit, Gate, Wire } from "@circuitlab/engine";
import type { LocalCircuit } from "../../electron/bridge";
import { createCircuit, deleteCircuit, getCircuit, getNetlist, replaceCircuit } from "../api";
import { desktop, requireDesktop, unwrap } from "../desktop";
import { pinCounts } from "../diagram/geometry";
import { autoLayout } from "../diagram/layout";
import { forgetPositions, positionsFor, savePositions } from "../diagram/saved-positions";
import { fileNameFor, saveFile } from "../dom";
import { draftFromCircuit, emptyDraft, toCircuitInput, type Draft } from "../editor/draft";
import type { Example } from "../examples";
import { deleteLibraryCircuit, fileName, openLibraryCircuit, readNetlistFile, saveLibraryCircuit, writeNetlistFile } from "../offline/storage";
import { emit } from "../shell/bus";
import { Notice } from "../ui";

/**
 * The circuit that is open in the workspace. Like Notepad, one at a time; unlike a page, it stays
 * open while you look at other screens (the sidebar shows it), until you close it.
 *
 * A circuit comes from one of five places, and that decides where Save puts it:
 * - the **library**, inside the app: back into the library;
 * - a **file**: back into the file;
 * - **new** (drawn from scratch, an example, the assistant's draft): into the library;
 * - the **server**: a new version of it on the server;
 * - **new for the server** (New circuit on "My circuits"): into your account.
 *
 * The circuit itself is a Draft (editor/draft.ts): what the drawing edits, the netlist editor
 * replaces, and the simulator runs.
 */
export type DocSource =
  | { readonly kind: "library"; readonly id: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "new" }
  | { readonly kind: "server"; readonly id: string }
  | { readonly kind: "new-server" };

/** The three ways to look at a circuit: try it, draw it, or write it as text. */
export type Mode = "sim" | "draw" | "net";

export interface OpenDoc {
  source: DocSource;
  draft: Draft;
  /**
   * The netlist text that goes with the draft: a file's own text (comments and all), or what was
   * last applied from the netlist editor. null once the drawing changed it: it is then written
   * from the drawing when needed.
   */
  text: string | null;
  /** The file had comments, which writing it from the drawing loses (said when it's saved). */
  fileHadComments: boolean;
  dirty: boolean;
  /** Library circuits: when last saved. */
  updatedAt?: string;
  /** Server circuits: the circuit as last loaded or saved, with its ETag (for If-Match). */
  server?: { circuit: CircuitResource; etag: string };
  mode: Mode;
  /** The drawing's zoom; null fits it to the window the next time it's shown. */
  zoom: number | null;
  /** The input switches. */
  inputs: Record<string, Bit>;
  /** Sequential circuits: what the loop remembered after the last step. */
  state?: Readonly<Record<string, Bit>>;
  steps: number;
  /** What the netlist editor holds while you type, before Apply. null: the circuit's own netlist. */
  netText: string | null;
}

let current: OpenDoc | null = null;
const listeners = new Set<() => void>();

export function currentDoc(): OpenDoc | null {
  return current;
}

/** Calls `listener` when a circuit is opened or closed, or the open one changes (its name, unsaved changes). */
export function onDocChange(listener: () => void, signal?: AbortSignal): void {
  listeners.add(listener);
  signal?.addEventListener("abort", () => listeners.delete(listener), { once: true });
}

/** Tells everyone showing the open circuit that it changed. */
export function docChanged(): void {
  for (const listener of [...listeners]) listener();
}

const OPEN_KEY = "circuitlab.openDocument";

/**
 * Makes `doc` the open circuit. If the open one has unsaved changes, asks first; returns false
 * when the person keeps it.
 */
export function replaceDoc(doc: OpenDoc): boolean {
  if (current !== null && current !== doc && current.dirty) {
    if (!confirm(`You have unsaved changes to “${current.draft.name}”. Open the other circuit without saving them?`)) return false;
  }
  current = doc;
  remember(doc.source);
  docChanged();
  return true;
}

/** Closes the open circuit, asking first if it has unsaved changes. Returns false when the person keeps it open. */
export function closeDoc(): boolean {
  if (current?.dirty === true && !confirm("You have unsaved changes. Close without saving them?")) return false;
  forceClose();
  return true;
}

function forceClose(): void {
  current = null;
  remember(null);
  docChanged();
}

/** The open circuit is remembered for a reload of the window (Ctrl+R), not a restart. A new one can't be reopened, so isn't. */
function remember(source: DocSource | null): void {
  try {
    if (source === null || source.kind === "new" || source.kind === "new-server") sessionStorage.removeItem(OPEN_KEY);
    else sessionStorage.setItem(OPEN_KEY, JSON.stringify(source));
  } catch {
    // storage blocked: the circuit just won't be reopened after a reload
  }
}

/** After the window reloads, the open circuit is read again from where it lives. */
export async function restoreDoc(): Promise<OpenDoc | null> {
  if (current !== null) return current;
  let source: DocSource | null = null;
  try {
    source = JSON.parse(sessionStorage.getItem(OPEN_KEY) ?? "null") as DocSource | null;
  } catch {
    return null;
  }
  try {
    if (source?.kind === "library") await openLibraryDoc(source.id);
    if (source?.kind === "file") await openFileDoc(source.path);
    if (source?.kind === "server") await openServerDoc(source.id);
  } catch {
    remember(null); // deleted or moved since: nothing to show
  }
  return current;
}

/** What to call the open circuit in the title bar and the sidebar: a file's name, or the circuit's. */
export function docLabel(doc: OpenDoc): string {
  return doc.source.kind === "file" ? fileName(doc.source.path) : doc.draft.name.trim() || "Untitled circuit";
}

// ---- opening ----------------------------------------------------------------------------------

/** The key the drawing's saved gate positions use (diagram/saved-positions.ts). */
export function positionsKeyOf(source: DocSource): string {
  switch (source.kind) {
    case "library":
      return `library:${source.id}`;
    case "file":
      return `file:${source.path}`;
    case "server":
      return source.id; // the key phase 13's circuit pages used
    case "new":
    case "new-server":
      return "file:unsaved";
  }
}

interface CircuitLike {
  readonly name: string;
  readonly description?: string;
  readonly gates: readonly Gate[];
  readonly wires: readonly Wire[];
}

/** A new OpenDoc. Its draft is `extra.draft` if given, else the circuit with the gate positions saved for it. */
function makeDoc(source: DocSource, circuit: CircuitLike, extra: Partial<OpenDoc> = {}): OpenDoc {
  const draft = extra.draft ?? draftFromCircuit(circuit, positionsFor(positionsKeyOf(source), circuit.gates, circuit.wires));
  return {
    source,
    text: null,
    fileHadComments: false,
    dirty: false,
    mode: "sim",
    zoom: null,
    inputs: Object.fromEntries(draft.gates.filter((gate) => gate.type === "INPUT").map((gate) => [gate.id, 0 as Bit])),
    steps: 0,
    netText: null,
    ...extra,
    draft,
  };
}

/** Opens `doc`, unless the person keeps the open circuit with its unsaved changes. */
function open(doc: OpenDoc): OpenDoc | null {
  return replaceDoc(doc) ? doc : null;
}

export async function openLibraryDoc(id: string): Promise<OpenDoc | null> {
  if (current?.source.kind === "library" && current.source.id === id) return current;
  const saved = await openLibraryCircuit(id);
  return open(
    makeDoc({ kind: "library", id }, { ...saved.circuit, ...(saved.item.description !== undefined && { description: saved.item.description }) }, { text: saved.text, updatedAt: saved.item.updatedAt }),
  );
}

export async function openFileDoc(path: string): Promise<OpenDoc | null> {
  return openOpenedFile(await readNetlistFile(path));
}

export function openOpenedFile(file: { readonly path: string; readonly text: string; readonly circuit: LocalCircuit }): OpenDoc | null {
  return open(makeDoc({ kind: "file", path: file.path }, file.circuit, { text: file.text, fileHadComments: file.text.includes("#") }));
}

export async function openServerDoc(id: string, signal?: AbortSignal): Promise<OpenDoc | null> {
  if (current?.source.kind === "server" && current.source.id === id) return current;
  const { circuit, etag } = await getCircuit(id, signal);
  return open(makeDoc({ kind: "server", id }, circuit, { server: { circuit, etag } }));
}

/** A netlist that isn't saved anywhere yet, laid out automatically. */
async function openNetlistText(text: string, description: string, dirty: boolean): Promise<OpenDoc | null> {
  const circuit = unwrap(await requireDesktop().parse(text));
  const draft = draftFromCircuit({ ...circuit, description }, autoLayout(circuit.gates, circuit.wires));
  return open(makeDoc({ kind: "new" }, circuit, { text, draft, dirty }));
}

/** A netlist from the assistant: unsaved work, because it can't be opened again like an example. */
export function openUnsavedText(text: string, description = ""): Promise<OpenDoc | null> {
  return openNetlistText(text, description, true);
}

/** An example. Closing it untouched loses nothing, so it only counts as unsaved once you edit it. */
export function openExample(example: Example): Promise<OpenDoc | null> {
  return openNetlistText(example.netlist, example.description, false);
}

/**
 * A blank drawing. `forServer`: Save puts it in your account instead of the library. Like an
 * example, it only counts as unsaved once you add something to it.
 */
export function openBlank(forServer = false): OpenDoc | null {
  const draft = emptyDraft();
  return open(makeDoc(forServer ? { kind: "new-server" } : { kind: "new" }, draft, { draft, mode: "draw", zoom: 1 }));
}

// ---- changing ---------------------------------------------------------------------------------

/** After the drawing changed: unsaved, and the netlist text must be written again from it. */
export function drawingChanged(doc: OpenDoc): void {
  doc.dirty = true;
  doc.text = null;
  doc.netText = null;
  syncInputs(doc);
  docChanged();
}

/** Keeps a switch for every INPUT gate, and only those (a renamed or new input starts at 0). */
export function syncInputs(doc: OpenDoc): void {
  const ids = doc.draft.gates.filter((gate) => gate.type === "INPUT").map((gate) => gate.id);
  doc.inputs = Object.fromEntries(ids.map((id) => [id, doc.inputs[id] ?? 0]));
}

/**
 * Replaces the circuit with what `text` describes (the netlist editor's Apply, the assistant's
 * change). Gates that keep their names keep their places; if any is new, everything is arranged
 * again. Throws a LocalError listing the mistakes if the text isn't a valid netlist.
 */
export async function applyNetlist(doc: OpenDoc, text: string): Promise<LocalCircuit> {
  const circuit = unwrap(await requireDesktop().parse(text));
  const old = doc.draft.positions;
  const keep = circuit.gates.every((gate) => old.has(gate.id));
  doc.draft.gates = [...circuit.gates];
  doc.draft.wires = [...circuit.wires];
  doc.draft.pins = pinCounts(circuit.gates, circuit.wires);
  doc.draft.positions = keep ? new Map(circuit.gates.map((gate) => [gate.id, old.get(gate.id) ?? { x: 0, y: 0 }])) : autoLayout(circuit.gates, circuit.wires);
  // Without a .name line the text keeps the circuit's name (the parser would call it "Untitled").
  if (/^\s*\.name\s/m.test(text)) doc.draft.name = circuit.name;
  doc.text = text;
  doc.netText = text;
  doc.dirty = true;
  doc.state = undefined;
  doc.steps = 0;
  syncInputs(doc);
  docChanged();
  return circuit;
}

/** The circuit as netlist text: its own text if it has one, else written from the drawing (which also checks it). */
export async function netlistOf(doc: OpenDoc): Promise<string> {
  if (doc.text !== null) return doc.text;
  const { text } = unwrap(await requireDesktop().toNetlist({ name: doc.draft.name.trim(), gates: doc.draft.gates, wires: doc.draft.wires }));
  return text;
}

// ---- saving -----------------------------------------------------------------------------------

/** What the Save button does for this circuit, in words. */
export function saveLabel(doc: OpenDoc): string {
  switch (doc.source.kind) {
    case "library":
    case "new":
      return "Save to library";
    case "file":
      return "Save";
    case "server":
    case "new-server":
      return "Save";
  }
}

export function saveHint(doc: OpenDoc): string {
  switch (doc.source.kind) {
    case "library":
    case "new":
      return "Saves it in your library, inside the app (Ctrl S)";
    case "file":
      return `Saves it back to ${doc.source.path} (Ctrl S)`;
    case "server":
      return "Saves a new version on the server (Ctrl S)";
    case "new-server":
      return "Saves it in your account on the server (Ctrl S)";
  }
}

/** Saves the open circuit where it belongs. Resolves to a message for the person, or null if they changed their mind. */
export async function saveDoc(doc: OpenDoc): Promise<string | null> {
  const name = doc.draft.name.trim();
  if (name === "") throw new Notice("Give the circuit a name first.");
  const source = doc.source;
  switch (source.kind) {
    case "library":
    case "new": {
      const saved = await saveLibraryCircuit({ ...(source.kind === "library" && { id: source.id }), netlist: await netlistOf(doc), description: doc.draft.description.trim() });
      doc.source = { kind: "library", id: saved.item.id };
      doc.text = saved.text;
      doc.updatedAt = saved.item.updatedAt;
      done(doc);
      return source.kind === "new" ? `Saved “${name}” in your library.` : "Saved.";
    }
    case "file": {
      // A drawing is written out from scratch, and a drawing has no comments: ask before losing the file's.
      if (doc.fileHadComments && doc.text === null && !confirm(`Saving writes ${fileName(source.path)} again from the drawing, so the comments in it will be lost. Save anyway?`)) return null;
      const text = await netlistOf(doc);
      unwrap(await requireDesktop().parse(text)); // never write a file that doesn't read back
      await writeNetlistFile(source.path, text, fileNameFor(name));
      doc.text = text;
      doc.fileHadComments = text.includes("#");
      done(doc);
      return `Saved to ${fileName(source.path)}.`;
    }
    case "server": {
      const before = doc.server;
      if (before === undefined) throw new Notice("This circuit isn't loaded yet.");
      // If-Match: if someone else saved in the meantime, the API refuses (412) instead of losing their work.
      const saved = await replaceCircuit(source.id, input(doc), before.etag);
      doc.server = { circuit: saved.circuit, etag: saved.etag };
      done(doc);
      emit("server");
      return `Saved: version ${saved.circuit.version}.`;
    }
    case "new-server": {
      const created = await createCircuit(input(doc));
      doc.source = { kind: "server", id: created.circuit.id };
      doc.server = { circuit: created.circuit, etag: created.etag };
      done(doc);
      emit("server");
      return `Saved “${name}” in your account.`;
    }
  }
}

function input(doc: OpenDoc): CircuitInput {
  return toCircuitInput(doc.draft);
}

/** After saving: nothing unsaved, and the gates keep the places you gave them. */
function done(doc: OpenDoc): void {
  doc.dirty = false;
  savePositions(positionsKeyOf(doc.source), doc.draft.positions);
  if (doc === current) {
    remember(doc.source);
    docChanged();
  }
}

/** A copy in the library, leaving the open circuit as it is (a file, or a circuit on the server). */
export async function copyToLibrary(doc: OpenDoc): Promise<string> {
  const saved = await saveLibraryCircuit({ netlist: await netlistOf(doc), description: doc.draft.description.trim() });
  savePositions(positionsKeyOf({ kind: "library", id: saved.item.id }), doc.draft.positions);
  return `Saved a copy of “${doc.draft.name}” in your library, where it works offline too.`;
}

/** The circuit as a .net file wherever you choose. Resolves to a message, or null if cancelled. */
export async function exportNetlist(doc: OpenDoc): Promise<string | null> {
  const name = fileNameFor(doc.draft.name);
  if (desktop() === null) {
    // In a browser tab (development): the server writes the netlist, and the browser downloads it.
    if (doc.source.kind !== "server" || doc.dirty) throw new Notice("Exporting needs the desktop app.");
    saveFile(new Blob([await getNetlist(doc.source.id)], { type: "text/plain" }), `${name}.net`);
    return "Download started.";
  }
  const path = await writeNetlistFile(null, await netlistOf(doc), name);
  return path === null ? null : `Exported to ${path}`;
}

/** Puts a copy in your account on the server and opens it there. */
export async function uploadToAccount(doc: OpenDoc, copyName?: string): Promise<OpenDoc | null> {
  const created = await createCircuit({ ...input(doc), ...(copyName !== undefined && { name: copyName.slice(0, 200) }) });
  savePositions(created.circuit.id, doc.draft.positions);
  emit("server");
  // The open circuit was only copied, so its own unsaved changes (if any) don't stop the switch.
  if (doc.dirty && doc === current) doc.dirty = false;
  return open(makeDoc({ kind: "server", id: created.circuit.id }, created.circuit, { server: { circuit: created.circuit, etag: created.etag }, draft: doc.draft }));
}

/** Deletes the open circuit from the library or the server (the caller asks first), and closes it. */
export async function deleteDoc(doc: OpenDoc): Promise<void> {
  const source = doc.source;
  if (source.kind === "library") {
    await deleteLibraryCircuit(source.id);
  } else if (source.kind === "server" && doc.server !== undefined) {
    await deleteCircuit(source.id, doc.server.etag);
    emit("server");
  } else {
    throw new Notice("Only circuits in the library or on the server can be deleted here.");
  }
  forgetPositions(positionsKeyOf(source));
  if (doc === current) forceClose();
}
