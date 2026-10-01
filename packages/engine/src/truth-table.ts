import { CompiledCircuit, compileCircuit, runPlan } from "./compile";
import { showValue } from "./internal/util";
import type { Bit, Circuit } from "./types";

/**
 * Most inputs a truth table can have. Rows are numbered, and every row number must be an exact
 * JavaScript integer (below 2^53) so that paging to any row is reliable.
 */
export const MAX_TRUTH_TABLE_INPUTS = 53;

/** A window of rows, for paging through tables too large to build at once. */
export interface TruthTableRange {
  /** First row to produce. Default 0. */
  readonly offset?: number;
  /** Most rows to produce. Default: every row from `offset` to the end. */
  readonly limit?: number;
}

export interface TruthTableRow {
  /** Row number. Written in binary, it is the input values, first input as the most significant bit. */
  readonly index: number;
  /** Input values, in `inputIds` order. */
  readonly inputs: readonly Bit[];
  /** Output values, in `outputIds` order. */
  readonly outputs: readonly Bit[];
}

export interface TruthTable {
  readonly inputIds: readonly string[];
  readonly outputIds: readonly string[];
  /** Rows in the complete table: 2 to the power of the number of inputs. */
  readonly totalRows: number;
  /** Row number of `rows[0]`. */
  readonly offset: number;
  readonly rows: readonly TruthTableRow[];
}

/**
 * Builds the truth table (or one window of it) in memory.
 *
 * @throws RangeError for a bad range, or a circuit with more than MAX_TRUTH_TABLE_INPUTS inputs
 * @throws CircuitValidationError or CycleError when given an invalid, uncompiled circuit
 */
export function truthTable(circuit: Circuit | CompiledCircuit, range: TruthTableRange = {}): TruthTable {
  const { compiled, start, end, totalRows } = plan(circuit, range);
  return {
    inputIds: compiled.inputIds,
    outputIds: compiled.outputIds,
    totalRows,
    offset: start,
    rows: [...generateRows(compiled, start, end)],
  };
}

/**
 * Produces rows one at a time, so a caller can stream a huge table without holding it in memory.
 * Arguments are checked immediately, not when the first row is requested.
 */
export function truthTableRows(circuit: Circuit | CompiledCircuit, range: TruthTableRange = {}): IterableIterator<TruthTableRow> {
  const { compiled, start, end } = plan(circuit, range);
  return generateRows(compiled, start, end);
}

function plan(circuit: Circuit | CompiledCircuit, range: TruthTableRange) {
  const compiled = circuit instanceof CompiledCircuit ? circuit : compileCircuit(circuit);
  const inputCount = compiled.inputIds.length;
  if (inputCount > MAX_TRUTH_TABLE_INPUTS) {
    throw new RangeError(`A truth table supports at most ${MAX_TRUTH_TABLE_INPUTS} inputs; this circuit has ${inputCount}`);
  }
  const totalRows = 2 ** inputCount;
  const offset = checkCount("offset", range.offset ?? 0);
  const limit = checkCount("limit", range.limit ?? Number.MAX_SAFE_INTEGER);
  const start = Math.min(offset, totalRows); // paging past the end gives an empty page
  return { compiled, start, end: Math.min(totalRows, start + limit), totalRows };
}

function checkCount(name: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Truth table "${name}" must be a whole number of at least 0, got ${showValue(value)}`);
  }
  return value;
}

// Declared separately so that `plan` runs eagerly: a generator's body only starts on the first `next()`.
function* generateRows(compiled: CompiledCircuit, start: number, end: number): Generator<TruthTableRow, void, undefined> {
  for (let index = start; index < end; index++) {
    const inputs = inputsForRow(index, compiled.inputIds.length);
    const read = runPlan(compiled, inputs);
    yield { index, inputs, outputs: compiled.outputSlots.map(read) };
  }
}

/**
 * The input values for a truth-table row: the row number in binary, first input most
 * significant. This is the single definition of what "row N" means, shared by everything
 * that pages through tables. Uses arithmetic rather than bit operators, which only work on
 * 32 bits in JavaScript.
 */
export function inputsForRow(index: number, count: number): Bit[] {
  const bits = new Array<Bit>(count);
  let rest = index;
  for (let k = count - 1; k >= 0; k--) {
    bits[k] = rest % 2 === 1 ? 1 : 0;
    rest = Math.floor(rest / 2);
  }
  return bits;
}
