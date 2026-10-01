import { GATE_ARITY, GATE_TYPES, MAX_GATE_INPUTS, compileCircuit, isGateType, simulate, truthTable, type Bit, type GateType } from "@circuitlab/engine";
import { describe, expect, it } from "vitest";
import { circuit, random, type GateSpec } from "./fixtures";

/** The definition of each gate, written independently of the engine: from the number of 1 inputs. */
const REFERENCE: Record<Exclude<GateType, "INPUT" | "OUTPUT" | "CONST">, (ones: number, n: number) => boolean> = {
  BUF: (ones) => ones === 1,
  NOT: (ones) => ones === 0,
  AND: (ones, n) => ones === n,
  OR: (ones) => ones > 0,
  NAND: (ones, n) => ones < n,
  NOR: (ones) => ones === 0,
  XOR: (ones) => ones % 2 === 1, // odd parity, however many inputs
  XNOR: (ones) => ones % 2 === 0,
};

/** One gate with `n` inputs, wired to an OUTPUT. */
function single(type: GateType, n: number) {
  const inputs = Array.from({ length: n }, (_, k): GateSpec => [`i${k}`, "INPUT"]);
  return circuit(type, ...inputs, ["g", type, ...inputs.map(([id]) => id)], ["Y", "OUTPUT", "g"]);
}

const ones = (bits: readonly Bit[]): number => bits.filter((bit) => bit === 1).length;

describe("gate logic", () => {
  it.each(["BUF", "NOT"] as const)("%s, for both input values", (type) => {
    for (const row of truthTable(single(type, 1)).rows) {
      expect(row.outputs[0]).toBe(REFERENCE[type](ones(row.inputs), 1) ? 1 : 0);
    }
  });

  describe.each(["AND", "OR", "NAND", "NOR", "XOR", "XNOR"] as const)("%s", (type) => {
    it.each([2, 3, 4, 5])("with %i inputs, for every combination", (n) => {
      const table = truthTable(single(type, n));
      expect(table.rows).toHaveLength(2 ** n);
      for (const row of table.rows) expect(row.outputs[0], `inputs ${row.inputs.join("")}`).toBe(REFERENCE[type](ones(row.inputs), n) ? 1 : 0);
    });

    it(`with the maximum of ${MAX_GATE_INPUTS} inputs`, () => {
      // 2^64 combinations can't be enumerated (nor put in a truth table, which allows 53 inputs),
      // so check the edge cases and a few hundred random ones.
      const n = MAX_GATE_INPUTS;
      const compiled = compileCircuit(single(type, n));
      const next = random(n);
      const vectors: Bit[][] = [
        Array<Bit>(n).fill(0),
        Array<Bit>(n).fill(1),
        ...Array.from({ length: n }, (_, hot) => Array.from({ length: n }, (_, k): Bit => (k === hot ? 1 : 0))),
        ...Array.from({ length: 300 }, () => Array.from({ length: n }, (): Bit => (next() < 0.5 ? 0 : 1))),
      ];
      for (const bits of vectors) {
        const inputs = Object.fromEntries(bits.map((bit, k) => [`i${k}`, bit]));
        expect(simulate(compiled, inputs).outputs.Y, `${ones(bits)} ones`).toBe(REFERENCE[type](ones(bits), n) ? 1 : 0);
      }
      expect(() => truthTable(compiled)).toThrow(RangeError);
    });
  });

  it("CONST gates have their value", () => {
    const table = truthTable(circuit("constants", ["zero", "CONST0"], ["one", "CONST1"], ["Z", "OUTPUT", "zero"], ["O", "OUTPUT", "one"]));
    expect(table.rows).toEqual([{ index: 0, inputs: [], outputs: [0, 1] }]);
  });
});

describe("arity", () => {
  it("is fixed for every gate type", () => {
    expect(GATE_ARITY).toEqual({
      INPUT: { min: 0, max: 0 },
      CONST: { min: 0, max: 0 },
      OUTPUT: { min: 1, max: 1 },
      BUF: { min: 1, max: 1 },
      NOT: { min: 1, max: 1 },
      AND: { min: 2, max: 64 },
      OR: { min: 2, max: 64 },
      NAND: { min: 2, max: 64 },
      NOR: { min: 2, max: 64 },
      XOR: { min: 2, max: 64 },
      XNOR: { min: 2, max: 64 },
    });
  });

  it("knows exactly the gate types", () => {
    for (const type of GATE_TYPES) expect(isGateType(type)).toBe(true);
    for (const value of ["and", "MUX", "", undefined, null, 1, {}]) expect(isGateType(value)).toBe(false);
  });
});
