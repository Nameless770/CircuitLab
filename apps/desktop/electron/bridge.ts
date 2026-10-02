import type { Bit, Gate, SimulationMode, Wire } from "@circuitlab/engine";

/**
 * Everything the app window may ask the main process to do, and the shapes that travel between
 * them. Types only: the main process implements it (main.ts), preload.ts passes the calls
 * along, and the window uses it as `window.circuitlab`.
 *
 * Why a bridge at all? The window shows web content, so it gets no Node.js powers (Electron's
 * recommended security setup: contextIsolation on, nodeIntegration off). It can only call the
 * few functions listed here, never read or write arbitrary files itself.
 */
export interface DesktopBridge {
  /** Online mode's server address, and where it comes from. */
  getSettings(): Promise<AppSettings>;
  /** Saves a new server address (null: back to the default). Resolves to the settings now in use. */
  setApiUrl(url: string | null): Promise<LocalResult<AppSettings>>;
  /** The netlist file the app was started with (a double-clicked .net file), the first time it's asked; then null. */
  takeStartupFile(): Promise<string | null>;
  /** A .net file double-clicked while the app is already open. */
  onOpenFile(listener: (path: string) => void): void;
  /** Shows the Open dialog and reads the netlist file. null if the user cancelled. */
  openFile(): Promise<LocalResult<OpenedFile> | null>;
  /** Reads a netlist file without a dialog (recent files). */
  readFile(path: string): Promise<LocalResult<OpenedFile>>;
  /** Writes netlist text to `path`, or asks where (Save As) when `path` is null. Resolves to the path, or null if cancelled. */
  saveFile(path: string | null, text: string, suggestedName: string): Promise<LocalResult<string | null>>;
  /** Reads netlist text (typed in the netlist editor, or an example). */
  parse(text: string): Promise<LocalResult<LocalCircuit>>;
  /** Checks a circuit from the drawing editor and writes it as netlist text. */
  toNetlist(circuit: CircuitData): Promise<LocalResult<{ readonly circuit: LocalCircuit; readonly text: string }>>;
  simulate(circuit: CircuitData, request: LocalSimulateRequest): Promise<LocalResult<LocalSimulation>>;
  truthTable(circuit: CircuitData, offset: number, limit: number): Promise<LocalResult<LocalTruthTablePage>>;
  /** Asks where to save, then writes the whole truth table as CSV. Resolves to the path, or null if cancelled. */
  exportTruthTable(circuit: CircuitData, suggestedName: string): Promise<LocalResult<string | null>>;
  /** Every circuit saved in the app's library, the most recently changed first. */
  listLibrary(): Promise<LocalResult<readonly LibraryItem[]>>;
  openFromLibrary(id: string): Promise<LocalResult<LibraryCircuit>>;
  /** Adds a circuit to the library (no `id`) or replaces one (with its `id`). */
  saveToLibrary(request: LibrarySaveRequest): Promise<LocalResult<LibraryCircuit>>;
  deleteFromLibrary(id: string): Promise<LocalResult<null>>;
  /** Commands from the app menu ("open", "new", "home"). */
  onMenuCommand(listener: (command: MenuCommand) => void): void;
}

export type MenuCommand = "open" | "new" | "home" | "library" | "settings";

/**
 * A circuit in the library: circuits saved inside the app (in its data folder), so offline work
 * is kept without choosing a file. What the Library page lists; the netlist itself isn't needed
 * for that, so it isn't here.
 */
export interface LibraryItem {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly summary: LibrarySummary;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Kept with each saved circuit, so the Library page can show it without reading every netlist. */
export interface LibrarySummary {
  readonly gates: number;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly feedbackLoop: readonly string[] | null;
}

/** A library circuit, opened. */
export interface LibraryCircuit {
  readonly item: LibraryItem;
  /** The circuit as netlist text: what the netlist editor shows. */
  readonly text: string;
  readonly circuit: LocalCircuit;
}

export interface LibrarySaveRequest {
  /** The library circuit to replace; leave it out to add a new one. */
  readonly id?: string;
  /** The circuit as netlist text (from the netlist editor, a file, or a drawing via toNetlist). */
  readonly netlist: string;
  readonly description?: string;
}

export interface AppSettings {
  /** The API address in use right now. */
  readonly apiUrl: string;
  /** What the Settings screen saved, or null if nothing was ever saved. */
  readonly savedApiUrl: string | null;
  readonly defaultApiUrl: string;
  /** CIRCUITLAB_API_URL is set (development, tests): it wins over the saved address for this run. */
  readonly fromEnvironment: boolean;
}

/** A circuit as the window sends it: what the netlist file holds. */
export interface CircuitData {
  readonly name: string;
  readonly gates: readonly Gate[];
  readonly wires: readonly Wire[];
}

/** A circuit read from a file, plus what the app shows about it (like the API's `summary`). */
export interface LocalCircuit extends CircuitData {
  readonly summary: {
    readonly inputs: readonly string[];
    readonly outputs: readonly string[];
    /** A loop of gate ids (first repeated at the end), or null if the circuit has none. */
    readonly feedbackLoop: readonly string[] | null;
  };
}

export interface OpenedFile {
  readonly path: string;
  /** Exactly what's in the file, comments and all. */
  readonly text: string;
  readonly circuit: LocalCircuit;
}

export interface LocalSimulateRequest {
  readonly inputs: Readonly<Record<string, Bit>>;
  readonly mode: SimulationMode;
  /** Sequential mode: what the loops remembered from the previous step. */
  readonly state?: Readonly<Record<string, Bit>>;
}

export interface LocalSimulation {
  readonly outputs: Readonly<Record<string, Bit>>;
  readonly signals: Readonly<Record<string, Bit>>;
  readonly state?: Readonly<Record<string, Bit>>;
}

export interface LocalTruthTablePage {
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly totalRows: number;
  readonly offset: number;
  readonly rows: readonly { readonly index: number; readonly inputs: readonly Bit[]; readonly outputs: readonly Bit[] }[];
}

/**
 * Errors can't cross from the main process to the window as real Error objects (only their
 * message survives), so every call answers with either a value or a problem described as data,
 * shaped like the API's problem documents so the window shows both the same way.
 */
export type LocalResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: LocalProblem };

export interface LocalProblem {
  /** Same codes as the API where they mean the same thing: invalid-netlist, invalid-circuit, feedback-loop, ... */
  readonly code: string;
  readonly message: string;
  readonly issues?: readonly LocalIssue[];
  readonly cycle?: readonly string[];
}

export interface LocalIssue {
  readonly code: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  readonly gateId?: string;
}
