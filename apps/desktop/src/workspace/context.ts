import type { SimulationOutcome } from "../circuit/backend";
import type { OpenDoc } from "./store";
import { summarize, type Summary } from "./summary";

/**
 * What the parts of the workspace share while it's on screen: the open circuit, and the things
 * about it that only matter while you look at it (what's selected, the last check, the last
 * simulation). The circuit itself lives on in the store when you go to another screen; this
 * doesn't.
 *
 * Each part draws itself from here, and calls refresh() with the parts that must redraw after a
 * change. That keeps it simple: no part reaches into another.
 */
export type Selection = { readonly kind: "gate"; readonly id: string } | { readonly kind: "wire"; readonly index: number } | null;

/** The result of a Check (the drawing's, or the netlist editor's). */
export type CheckResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: unknown } | null;

export type Part = "head" | "stage" | "diagram" | "inspector" | "table";

export interface SimStatus {
  readonly kind: "waiting" | "done" | "error";
  /** Who answered: "Simulated on this computer.", "Simulated by the server.", ... */
  readonly text: string;
  readonly error?: unknown;
}

export interface Ws {
  readonly doc: OpenDoc;
  readonly signal: AbortSignal;
  selection: Selection;
  /** Gates the last check complained about, outlined in red. */
  problemGates: Set<string>;
  drawCheck: CheckResult;
  netCheck: CheckResult;
  /** A gate name typed in the inspector that can't be used. */
  nameError: string | null;
  /** The last simulation, whose values colour the drawing. */
  last: SimulationOutcome | null;
  simStatus: SimStatus;
  /** Redraws these parts. */
  refresh(...parts: Part[]): void;
  /** Runs the simulation again (after a change to the circuit or the inputs). */
  resimulate(): void;
}

/** The circuit's inputs, outputs and loop, as it is now (it changes while you draw). */
export function summaryOf(ws: Ws): Summary {
  const { doc } = ws;
  // A server circuit as it is saved: the server's own summary.
  if (doc.source.kind === "server" && !doc.dirty && doc.server !== undefined) return doc.server.circuit.summary;
  return summarize(doc.draft.gates, doc.draft.wires);
}
