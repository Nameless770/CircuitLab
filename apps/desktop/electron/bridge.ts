import type { Bit, Gate, SimulationMode, Wire } from "@circuitlab/engine";
import type { WindowTheme } from "./helpers";

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
  /** Whether Ollama answers, which models it has, and which one the assistant would use. Never fails: what's wrong is in the answer. */
  assistantStatus(): Promise<AssistantStatus>;
  /** Saves where Ollama is and which model to use (null: back to the default). Resolves to the settings now in use. */
  setAssistant(change: AssistantSettingsChange): Promise<LocalResult<AppSettings>>;
  /** Asks the assistant for a circuit, or for a change to the netlist in `request`. Progress arrives through onAssistantProgress. */
  askAssistant(request: AssistantRequest): Promise<LocalResult<AssistantAnswer>>;
  /** Stops the question being worked on, if any: askAssistant then ends with the code "cancelled". */
  cancelAssistant(): Promise<void>;
  /** Before each time the model is asked, while askAssistant is working. */
  onAssistantProgress(listener: (progress: AssistantProgress) => void): void;
  /**
   * The window's theme changed (or the window just started): the main process colours the strip
   * behind Windows' own window buttons to match, and opens the next window in this theme.
   */
  setWindowTheme(theme: WindowTheme): Promise<void>;
}

export type { WindowTheme };

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
  readonly assistant: AssistantSettings;
}

/** Where Ollama is, and which of its models the assistant uses. */
export interface AssistantSettings {
  /** The address in use right now. */
  readonly url: string;
  /** What the Settings screen saved, or null if nothing was ever saved. */
  readonly savedUrl: string | null;
  readonly defaultUrl: string;
  /** CIRCUITLAB_OLLAMA_URL is set (tests): it wins over the saved address for this run. */
  readonly fromEnvironment: boolean;
  /** The model chosen in Settings, or null for "the first one Ollama lists". */
  readonly savedModel: string | null;
}

/** What to change in the assistant's settings. A part that's left out stays as it is; null goes back to the default. */
export interface AssistantSettingsChange {
  readonly url?: string | null;
  readonly model?: string | null;
}

export interface AssistantModel {
  readonly name: string;
  /** "3.2B", when Ollama says. */
  readonly parameterSize?: string;
  readonly sizeGigabytes: number;
}

export interface AssistantStatus {
  readonly url: string;
  /** The address is this computer, so nothing typed to the assistant leaves it. */
  readonly local: boolean;
  /** Every model Ollama has, newest first. */
  readonly models: readonly AssistantModel[];
  /** The one that would be used, or null when there is none. */
  readonly model: string | null;
  /** What is wrong, written for people: Ollama isn't running, has no models, or the chosen model is gone. */
  readonly problem?: string;
}

export interface AssistantRequest {
  /** What the person wants, in their own words. */
  readonly request: string;
  /** The netlist to change (the text in the editor). Left out when the request is for a new circuit. */
  readonly netlist?: string;
}

/** Sent while a question is being worked on, before each time the model is asked. */
export interface AssistantProgress {
  /** 1 for the first answer. */
  readonly attempt: number;
  readonly of: number;
  /** How many problems the model's last answer had, which it is being asked to fix. 0 for the first. */
  readonly problems: number;
}

export type AssistantAnswer =
  | {
      readonly kind: "circuit";
      readonly model: string;
      readonly attempts: number;
      /** The model's own sentence on how the circuit works. */
      readonly idea: string;
      /** Checked: it reads back as `circuit`. */
      readonly netlist: string;
      readonly circuit: LocalCircuit;
      /** Every row, for a circuit with up to 4 inputs and no feedback loop; null otherwise. */
      readonly table: LocalTruthTablePage | null;
    }
  /** The model said it can't make that. */
  | { readonly kind: "declined"; readonly message: string }
  /** Every answer had problems; these are the last one's. */
  | { readonly kind: "invalid"; readonly attempts: number; readonly problems: readonly string[] };

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
