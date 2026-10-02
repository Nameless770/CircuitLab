import type { PackedTruthTable } from "@circuitlab/runner";

/**
 * Truth-table rows in their smallest form, for keeping them (cached pages, job results). The
 * pool's pages already leave the inputs out, since row n's inputs are n in binary, and hold one
 * byte per output value; here each output value takes one bit. A million rows of a 4-output
 * circuit are 500 KiB, where the same rows as CSV are about 25 MiB.
 */
export interface StoredRows {
  readonly offset: number;
  readonly rowCount: number;
  /** The output values, row after row, 8 to a byte, the first in the highest bit. */
  readonly bits: Buffer;
}

/** What every page of one table shares. */
export interface TableShape {
  readonly inputIds: readonly string[];
  readonly outputIds: readonly string[];
  readonly totalRows: number;
}

export function packRows(page: PackedTruthTable): StoredRows {
  const values = page.outputs;
  const bits = Buffer.alloc(Math.ceil(values.length / 8));
  for (let i = 0; i < values.length; i++) if (values[i] === 1) bits[i >>> 3]! |= 0x80 >>> (i & 7);
  return { offset: page.offset, rowCount: page.rowCount, bits };
}

export function unpackRows(rows: StoredRows, shape: TableShape): PackedTruthTable {
  const outputs = new Uint8Array(rows.rowCount * shape.outputIds.length);
  for (let i = 0; i < outputs.length; i++) outputs[i] = (rows.bits[i >>> 3]! >>> (7 - (i & 7))) & 1;
  return { ...shape, offset: rows.offset, rowCount: rows.rowCount, outputs };
}

/**
 * Splits a page into pages of at most `rowsEach` rows, sharing its memory. Turning rows into
 * objects and text costs about a microsecond each on the main thread, so a download handles a big
 * stored chunk in small slices, with other requests served in between.
 */
export function* slices(page: PackedTruthTable, rowsEach: number): Generator<PackedTruthTable, void, undefined> {
  const width = page.outputIds.length;
  for (let start = 0; start < page.rowCount; start += rowsEach) {
    const rowCount = Math.min(rowsEach, page.rowCount - start);
    yield { ...page, offset: page.offset + start, rowCount, outputs: page.outputs.subarray(start * width, (start + rowCount) * width) };
  }
}
