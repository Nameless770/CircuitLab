import { MAX_TRUTH_TABLE_INPUTS, inputsForRow, truthTable, truthTableRows } from "@circuitlab/engine";
import { describe, expect, it } from "vitest";
import { circuit, fullAdder, rippleCarryAdder, type GateSpec } from "./fixtures";

/** `n` inputs, all feeding one XOR (or a chain of them past 64 pins). Its output is the row's parity. */
function parityOf(n: number) {
  const specs: GateSpec[] = Array.from({ length: n }, (_, k): GateSpec => [`i${k}`, "INPUT"]);
  let last = "i0";
  for (let k = 1; k < n; k++) {
    specs.push([`x${k}`, "XOR", last, `i${k}`]);
    last = `x${k}`;
  }
  specs.push(["P", "OUTPUT", last]);
  return circuit(`${n}-input parity`, ...specs);
}

describe("inputsForRow", () => {
  it("is the row number in binary, first input most significant", () => {
    expect(inputsForRow(0, 3)).toEqual([0, 0, 0]);
    expect(inputsForRow(5, 3)).toEqual([1, 0, 1]);
    expect(inputsForRow(6, 3)).toEqual([1, 1, 0]);
  });

  it("stays exact beyond 32 bits, where JavaScript's bit operators would wrap around", () => {
    for (const row of [2 ** 32, 2 ** 40 + 5, 2 ** 52 + 3, Number.MAX_SAFE_INTEGER]) {
      expect(inputsForRow(row, 53).join("")).toBe(BigInt(row).toString(2).padStart(53, "0"));
    }
  });
});

describe("truthTable", () => {
  it("lists every row, numbered", () => {
    const table = truthTable(fullAdder());
    expect(table.totalRows).toBe(8);
    expect(table.offset).toBe(0);
    expect(table.rows.map((row) => row.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("serves any window of rows, the same as the whole table's rows", () => {
    const adder = rippleCarryAdder(3);
    const whole = truthTable(adder).rows;
    for (const [offset, limit] of [[0, 5], [17, 3], [120, 50], [127, 1]] as const) {
      const window = truthTable(adder, { offset, limit });
      expect(window.offset).toBe(offset);
      expect(window.rows).toEqual(whole.slice(offset, offset + limit));
    }
  });

  it("returns an empty page past the end, rather than failing", () => {
    expect(truthTable(fullAdder(), { offset: 8 }).rows).toEqual([]);
    expect(truthTable(fullAdder(), { offset: 1000, limit: 5 }).rows).toEqual([]);
  });

  it.each([{ offset: -1 }, { offset: 1.5 }, { limit: -2 }, { offset: Number.NaN }, { limit: "10" as never }])("refuses the range %j", (range) => {
    expect(() => truthTable(fullAdder(), range)).toThrow(RangeError);
  });

  it(`handles the largest table, ${MAX_TRUTH_TABLE_INPUTS} inputs, at its very last rows`, () => {
    const table = truthTable(parityOf(MAX_TRUTH_TABLE_INPUTS), { offset: 2 ** 53 - 3 });
    expect(table.totalRows).toBe(2 ** 53);
    expect(table.rows.map((row) => row.index)).toEqual([2 ** 53 - 3, 2 ** 53 - 2, 2 ** 53 - 1]);
    for (const row of table.rows) expect(row.outputs).toEqual([row.inputs.filter((bit) => bit === 1).length % 2]);
  });

  it(`refuses circuits with more than ${MAX_TRUTH_TABLE_INPUTS} inputs`, () => {
    expect(() => truthTable(parityOf(MAX_TRUTH_TABLE_INPUTS + 1), { limit: 1 })).toThrow(RangeError);
  });
});

describe("truthTableRows", () => {
  it("produces rows lazily, so a huge table can be streamed", () => {
    const rows = truthTableRows(parityOf(40));
    const first = [rows.next().value, rows.next().value, rows.next().value];
    expect(first.map((row) => row?.index)).toEqual([0, 1, 2]);
  });

  it("checks its arguments at once, not when the first row is requested", () => {
    expect(() => truthTableRows(fullAdder(), { offset: -1 })).toThrow(RangeError);
  });
});
