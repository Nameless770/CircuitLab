import {
  CircuitValidationError,
  CycleError,
  OscillationError,
  SimulationInputError,
  assertValidCircuit,
  compileCircuit,
  simulationStrategy,
  truthTable,
  truthTableRows,
  type Circuit,
  type SimulationInputs,
  type SimulationState,
} from "@circuitlab/engine";
import { NetlistError, formatNetlist, parseNetlist } from "@circuitlab/netlist";
import type { CircuitData, LocalCircuit, LocalProblem, LocalSimulateRequest, LocalSimulation, LocalTruthTablePage } from "./bridge";
import { NotInLibraryError, SettingError } from "./helpers";

/**
 * Offline mode: the same engine and netlist packages the API uses, called directly in the main
 * process. No Electron imports here, so this file is unit tested like any other module
 * (test/offline.test.ts).
 *
 * Everything coming from the window is treated as untrusted input: the engine validates every
 * circuit before using it, exactly as it does for the API.
 */

/** Largest truth table exported to CSV, the same limit as the API's downloads. */
export const MAX_EXPORT_ROWS = 1_048_576;
/** Most rows in one page, the same limit as the API's JSON pages. */
export const MAX_PAGE_ROWS = 4_096;

/** Reads netlist text. A netlist without a `.name` line is named after its file. */
export function readNetlist(text: string, fallbackName: string): LocalCircuit {
  return describe(parseNetlist(text), fallbackName);
}

/** Checks a circuit from the drawing editor and writes it as netlist text. */
export function toNetlist(data: CircuitData): { circuit: LocalCircuit; text: string } {
  const circuit = validCircuit(data);
  return { circuit: describe(circuit, "Untitled circuit"), text: [...formatNetlist(circuit)].join("") };
}

export function simulate(data: CircuitData, request: LocalSimulateRequest): LocalSimulation {
  const mode = request.mode === "sequential" ? "sequential" : "combinational";
  // The engine checks the inputs and the state itself (SimulationInputError), as it does for the API.
  const result = simulationStrategy(mode)
    .prepare(data)
    .run(request.inputs as SimulationInputs, request.state as SimulationState | undefined);
  return { outputs: result.outputs, signals: result.signals, ...(result.mode === "sequential" && { state: result.state }) };
}

export function truthTablePage(data: CircuitData, offset: number, limit: number): LocalTruthTablePage {
  const table = truthTable(compileCircuit(data), { offset, limit: Math.min(Math.max(1, limit), MAX_PAGE_ROWS) });
  return { inputs: table.inputIds, outputs: table.outputIds, totalRows: table.totalRows, offset: table.offset, rows: table.rows };
}

/**
 * Checks that a truth table can be exported, before asking the user where to save it.
 * @throws CycleError, CircuitValidationError, RangeError (too many rows)
 */
export function checkExport(data: CircuitData): void {
  const compiled = compileCircuit(data);
  const rows = 2 ** compiled.inputIds.length;
  if (rows > MAX_EXPORT_ROWS) {
    throw new RangeError(`This table has ${rows.toLocaleString("en")} rows; the most a CSV export takes is ${MAX_EXPORT_ROWS.toLocaleString("en")} (20 inputs).`);
  }
}

/**
 * The truth table as CSV text, produced a chunk at a time so a million rows never sit in memory
 * at once. Same format as the API's CSV: a header `#,<inputs>,<outputs>`, then one line per row.
 */
export function* truthTableCsv(data: CircuitData): Generator<string, void, undefined> {
  checkExport(data);
  const compiled = compileCircuit(data);
  let chunk = `#,${[...compiled.inputIds, ...compiled.outputIds].join(",")}\n`;
  let lines = 0;
  for (const row of truthTableRows(compiled)) {
    chunk += `${row.index},${[...row.inputs, ...row.outputs].join(",")}\n`;
    if (++lines === 2_000) {
      yield chunk;
      chunk = "";
      lines = 0;
    }
  }
  if (chunk !== "") yield chunk;
}

/** The circuit plus what the app shows about it. @throws CircuitValidationError */
function describe(circuit: Circuit, fallbackName: string): LocalCircuit {
  let feedbackLoop: readonly string[] | null = null;
  try {
    compileCircuit(circuit);
  } catch (error) {
    if (!(error instanceof CycleError)) throw error;
    feedbackLoop = error.cycle; // a loop is fine (a latch); it just needs sequential mode
  }
  return {
    name: circuit.name ?? fallbackName,
    gates: circuit.gates,
    wires: circuit.wires,
    summary: {
      inputs: circuit.gates.filter((gate) => gate.type === "INPUT").map((gate) => gate.id),
      outputs: circuit.gates.filter((gate) => gate.type === "OUTPUT").map((gate) => gate.id),
      feedbackLoop,
    },
  };
}

function validCircuit(data: CircuitData): Circuit {
  assertValidCircuit(data);
  const name = typeof data.name === "string" && data.name.trim() !== "" ? data.name.trim() : undefined;
  return { ...(name !== undefined && { name }), gates: data.gates, wires: data.wires };
}

/** Any error, described as data for the window, with the same codes the API would use. */
export function toProblem(error: unknown): LocalProblem {
  if (error instanceof NetlistError) {
    return {
      code: "invalid-netlist",
      message: "The netlist has problems.",
      issues: error.issues.map((issue) => ({ code: issue.code, message: issue.message, line: issue.line, ...(issue.column !== undefined && { column: issue.column }) })),
    };
  }
  if (error instanceof CircuitValidationError) {
    return {
      code: "invalid-circuit",
      message: "The circuit isn't finished or has mistakes.",
      issues: error.issues.map((issue) => ({ code: issue.code, message: issue.message, ...(issue.gateId !== undefined && { gateId: issue.gateId }) })),
    };
  }
  if (error instanceof CycleError) {
    return { code: "feedback-loop", message: "The circuit has a feedback loop, so it has no truth table: its outputs also depend on what it remembers.", cycle: error.cycle };
  }
  if (error instanceof OscillationError) {
    return { code: "does-not-settle", message: `The circuit never settles: the loop of gates ${error.gates.join(", ")} keeps changing (it oscillates).` };
  }
  if (error instanceof SimulationInputError) {
    return { code: "invalid-inputs", message: "The input values don't fit the circuit.", issues: error.issues.map((issue) => ({ code: issue.code, message: issue.message })) };
  }
  if (error instanceof SettingError) return { code: "invalid-setting", message: error.message };
  if (error instanceof NotInLibraryError) return { code: "not-found", message: error.message };
  if (error instanceof RangeError) return { code: "too-large", message: error.message };
  const code = (error as { code?: unknown }).code; // file system errors, e.g. ENOENT
  if (typeof code === "string") return { code: "file-error", message: (error as Error).message };
  return { code: "internal-error", message: `Something went wrong: ${error instanceof Error ? error.message : String(error)}` };
}
