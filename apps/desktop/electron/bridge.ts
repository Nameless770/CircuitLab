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
  /** Where online mode's API is (CIRCUITLAB_API_URL, default http://localhost:3000). */
  apiUrl(): Promise<string>;
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
  /** Commands from the app menu ("open", "new", "home"). */
  onMenuCommand(listener: (command: MenuCommand) => void): void;
}

export type MenuCommand = "open" | "new" | "home";

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
