import { compileCircuit, simulate, truthTable, type Bit } from "@circuitlab/engine";
import { describe, expect, it } from "vitest";
import { c17, c17Reference, fromBits, fullAdder, halfAdder, multiplexer, random, rippleCarryAdder, toBits } from "./fixtures";

describe("half adder", () => {
  it("has the textbook truth table", () => {
    const table = truthTable(halfAdder());
    expect(table.inputIds).toEqual(["A", "B"]);
    expect(table.outputIds).toEqual(["S", "C"]);
    expect(table.rows.map((row) => [...row.inputs, ...row.outputs])).toEqual([
      // A  B  S  C
      [0, 0, 0, 0],
      [0, 1, 1, 0],
      [1, 0, 1, 0],
      [1, 1, 0, 1],
    ]);
  });

  it("simulates one input combination, with every gate's signal", () => {
    expect(simulate(halfAdder(), { A: 1, B: 1 })).toEqual({
      outputs: { S: 0, C: 1 },
      signals: { A: 1, B: 1, sum: 0, carry: 1, S: 0, C: 1 },
      order: ["A", "B", "sum", "carry", "S", "C"],
    });
  });
});

describe("full adder", () => {
  it("adds three bits: S + 2*Cout = A + B + Cin, for all 8 rows", () => {
    const rows = truthTable(fullAdder()).rows;
    expect(rows).toHaveLength(8);
    for (const { inputs, outputs } of rows) {
      const [a = 0, b = 0, cin = 0] = inputs;
      const [s = 0, cout = 0] = outputs;
      expect(s + 2 * cout, `inputs ${inputs.join("")}`).toBe(a + b + cin);
    }
  });
});

describe("ripple-carry adder", () => {
  it("adds every pair of 6-bit numbers, with and without carry in (8,192 rows)", () => {
    const bits = 6;
    const table = truthTable(rippleCarryAdder(bits));
    expect(table.totalRows).toBe(2 ** (2 * bits + 1));
    for (const row of table.rows) {
      // The row number spells A, B, cin; the outputs spell cout followed by the sum bits.
      const a = fromBits(row.inputs.slice(0, bits));
      const b = fromBits(row.inputs.slice(bits, 2 * bits));
      const cin = fromBits(row.inputs.slice(2 * bits));
      expect(fromBits(row.outputs), `${a} + ${b} + ${cin}`).toBe(a + b + cin);
    }
  });

  it("adds random 64-bit numbers, compared with BigInt arithmetic", () => {
    const bits = 64;
    const adder = compileCircuit(rippleCarryAdder(bits));
    const next = random(2026);
    const word = (): bigint => BigInt(Math.floor(next() * 2 ** 32)) * 2n ** 32n + BigInt(Math.floor(next() * 2 ** 32));
    const cases: [bigint, bigint, Bit][] = [
      [0n, 0n, 0],
      [2n ** 64n - 1n, 1n, 0], // overflows into cout
      [2n ** 64n - 1n, 2n ** 64n - 1n, 1],
      ...Array.from({ length: 200 }, (): [bigint, bigint, Bit] => [word(), word(), next() < 0.5 ? 0 : 1]),
    ];
    for (const [a, b, cin] of cases) {
      const inputs: Record<string, Bit> = { cin };
      toBits(a, bits).forEach((bit, k) => (inputs[`a${bits - 1 - k}`] = bit));
      toBits(b, bits).forEach((bit, k) => (inputs[`b${bits - 1 - k}`] = bit));
      const { outputs } = simulate(adder, inputs);
      const sum = fromBits([outputs.cout ?? 0, ...Array.from({ length: bits }, (_, k) => outputs[`s${bits - 1 - k}`] ?? 0)]);
      expect(sum, `${a} + ${b} + ${cin}`).toBe(a + b + BigInt(cin));
    }
  });
});

describe("2:1 multiplexer", () => {
  it("passes a when sel is 0 and b when sel is 1", () => {
    for (const { inputs, outputs } of truthTable(multiplexer()).rows) {
      const [a, b, sel] = inputs;
      expect(outputs).toEqual([sel === 1 ? b : a]);
    }
  });
});

describe("ISCAS-85 c17", () => {
  it("matches its boolean definition for all 32 input combinations", () => {
    for (const { inputs, outputs } of truthTable(c17()).rows) {
      const [n1, n2, n3, n6, n7] = inputs.map((bit) => bit === 1);
      const expected = c17Reference(n1 ?? false, n2 ?? false, n3 ?? false, n6 ?? false, n7 ?? false).map((value) => (value ? 1 : 0));
      expect(outputs, `inputs ${inputs.join("")}`).toEqual(expected);
    }
  });
});
