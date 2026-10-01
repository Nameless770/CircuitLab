import { inputsForRow, type Bit, type ErrorData, type SimulationMode, type TruthTable, type TruthTableRange } from "@circuitlab/engine";

// Messages exchanged between SimulationPool (main thread) and worker.ts. Everything here is
// copied between threads with the structured clone algorithm, so it must be plain data.

export type TaskPayload =
  | { readonly kind: "simulate"; readonly circuit: unknown; readonly inputs: unknown; readonly mode: SimulationMode; readonly state: unknown }
  | { readonly kind: "truthTable"; readonly circuit: unknown; readonly range: TruthTableRange };

export type TaskRequest = TaskPayload & { readonly id: number };

export type TaskResponse =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly failure: TaskFailure };

export type TaskFailure =
  /** An engine error, sent as its `toJSON()` data and rebuilt with `reviveError`. */
  | { readonly kind: "engine"; readonly data: ErrorData }
  /**
   * Anything else (a bug, or a RangeError for bad arguments). Structured clone already keeps
   * built-in error types, their message, and the worker's stack trace.
   */
  | { readonly kind: "other"; readonly error: unknown };

/**
 * A truth table in compact form for the trip between threads. Copying row objects is slow
 * (about 2 µs per row, and the receiving half runs on the main thread), so instead:
 *   - inputs are not sent at all: they follow from the row number (`inputsForRow`);
 *   - outputs are one byte each in a single buffer, which is *transferred*, not copied.
 */
export interface PackedTruthTable {
  readonly inputIds: readonly string[];
  readonly outputIds: readonly string[];
  readonly totalRows: number;
  readonly offset: number;
  /** Stored explicitly: a circuit without outputs still has rows. */
  readonly rowCount: number;
  /** Row after row, `outputIds.length` bytes per row. */
  readonly outputs: Uint8Array<ArrayBuffer>;
}

export function pack(table: TruthTable): PackedTruthTable {
  const width = table.outputIds.length;
  const outputs = new Uint8Array(table.rows.length * width);
  table.rows.forEach((row, r) => outputs.set(row.outputs, r * width));
  const { inputIds, outputIds, totalRows, offset } = table;
  return { inputIds, outputIds, totalRows, offset, rowCount: table.rows.length, outputs };
}

export function unpack(packed: PackedTruthTable): TruthTable {
  const width = packed.outputIds.length;
  const rows = Array.from({ length: packed.rowCount }, (_, r) => {
    const index = packed.offset + r;
    return {
      index,
      inputs: inputsForRow(index, packed.inputIds.length),
      outputs: Array.from(packed.outputs.subarray(r * width, (r + 1) * width)) as Bit[],
    };
  });
  return { inputIds: packed.inputIds, outputIds: packed.outputIds, totalRows: packed.totalRows, offset: packed.offset, rows };
}
