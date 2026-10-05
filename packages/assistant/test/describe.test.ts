import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileCircuit, simulationStrategy, truthTable, type Circuit } from "@circuitlab/engine";
import { parseNetlist } from "@circuitlab/netlist";
import { describe, expect, it } from "vitest";
import { MAX_DESCRIBED_GATES, buildCircuit, describeCircuit, type CircuitSpec } from "@circuitlab/assistant";
import { circuit, dLatch, fullAdder, halfAdder, multiplexer, c17, random, randomCircuit, rippleCarryAdder, srLatch } from "../../engine/test/fixtures";

const NETLISTS = join(__dirname, "..", "..", "..", "examples", "netlists");
const netlist = (file: string): Circuit => parseNetlist(readFileSync(join(NETLISTS, file), "utf8"));

function specOf(source: Circuit): CircuitSpec {
  const described = describeCircuit(source);
  if (!described.ok) throw new Error(described.reason);
  return described.spec;
}

/** The circuit rebuilt from its own description. */
function rebuilt(source: Circuit): Circuit {
  const built = buildCircuit(specOf(source));
  if (!built.ok) throw new Error(built.problems.join(" | "));
  return built.circuit;
}

const formulasOf = (spec: CircuitSpec): Record<string, string> => Object.fromEntries([...spec.signals, ...spec.outputs].map((definition) => [definition.name, definition.formula]));

type Rows = { inputs: Record<string, number>; outputs: Record<string, number> }[];
function behaviour(source: Circuit): Rows {
  const table = truthTable(compileCircuit(source), { offset: 0, limit: 4096 });
  return table.rows.map((row) => ({
    inputs: Object.fromEntries(table.inputIds.map((id, index) => [id, row.inputs[index] as number])),
    outputs: Object.fromEntries(table.outputIds.map((id, index) => [id, row.outputs[index] as number])),
  }));
}

describe("describeCircuit: a circuit in the model's words", () => {
  it("writes the half adder from the examples as two formulas", () => {
    const spec = specOf(netlist("half-adder.net"));
    expect(spec.name).toBe("Half adder");
    expect(spec.inputs).toEqual(["A", "B"]);
    expect(spec.signals).toEqual([]);
    expect(formulasOf(spec)).toEqual({ S: "A ^ B", C: "A & B" });
  });

  it("writes gates used once inside the formula that uses them", () => {
    const spec = specOf(netlist("full-adder.net"));
    expect(formulasOf(spec)).toEqual({ S: "A ^ B ^ Cin", Cout: "(A & B) | (A & Cin) | (B & Cin)" });
  });

  it("makes a signal of a gate that two gates use, and writes it once", () => {
    const spec = specOf(circuit("Shared", ["a", "INPUT"], ["b", "INPUT"], ["x", "XOR", "a", "b"], ["y", "AND", "x", "a"], ["z", "OR", "x", "b"], ["o1", "OUTPUT", "y"], ["o2", "OUTPUT", "z"]));
    expect(formulasOf(spec)).toEqual({ x: "a ^ b", o1: "x & a", o2: "x | b" });
    expect(spec.signals).toEqual([{ name: "x", formula: "a ^ b" }]);
  });

  it("writes a gate that nothing but one other gate uses inside that gate's formula", () => {
    const spec = specOf(fullAdder());
    expect(spec.signals).toEqual([]);
    expect(spec.outputs.every((output) => output.formula.length > 0)).toBe(true);
  });

  it("writes a loop as signals that name each other, with the gates that have no operator as functions", () => {
    const spec = specOf(netlist("sr-latch.net"));
    expect(formulasOf(spec)).toEqual({ q: "NOR(R, qbar)", qbar: "NOR(S, q)", out_q: "q", out_qbar: "qbar" });
  });

  it("keeps the order of inputs and outputs, and writes constants and inverters plainly", () => {
    const spec = specOf(circuit("Mixed", ["a", "INPUT"], ["one", "CONST1"], ["n", "NOT", "a"], ["g", "AND", "n", "one"], ["b", "BUF", "g"], ["y", "OUTPUT", "b"], ["z", "OUTPUT", "n"]));
    expect(spec.inputs).toEqual(["a"]);
    expect(spec.outputs.map((output) => output.name)).toEqual(["y", "z"]);
    // The inverter is read by two gates, so it is a signal; the constant and the buffer are written inline.
    expect(formulasOf(spec)).toEqual({ n: "!a", y: "n & 1", z: "n" });
  });

  it("refuses a circuit that is too big to show a model, and says so", () => {
    const big = randomCircuit(random(1), 4, MAX_DESCRIBED_GATES);
    const described = describeCircuit(big);
    expect(described.ok).toBe(false);
    expect(!described.ok && described.reason).toMatch(/can change circuits of up to 80/);
  });

  it("refuses names it can't write in a formula", () => {
    for (const bad of ["x[1]", "a.b", "and", "1st"]) {
      const described = describeCircuit(circuit("Odd", [bad, "INPUT"], ["y", "OUTPUT", bad]));
      expect(described.ok, bad).toBe(false);
      expect(!described.ok && described.reason).toContain(`“${bad}”`);
    }
  });
});

describe("describeCircuit then buildCircuit: the same behaviour, whatever the circuit", () => {
  const combinational: [string, Circuit][] = [
    ["half adder", halfAdder()],
    ["full adder", fullAdder()],
    ["multiplexer", multiplexer()],
    ["ISCAS c17", c17()],
    ["2-bit ripple adder", rippleCarryAdder(2)],
    ["half adder file", netlist("half-adder.net")],
    ["full adder file", netlist("full-adder.net")],
    ["c17 file", netlist("c17.net")],
    ...Array.from({ length: 25 }, (_, seed): [string, Circuit] => [`random circuit ${seed}`, randomCircuit(random(seed + 100), 3 + (seed % 3), 6 + (seed % 12))]),
  ];

  for (const [name, source] of combinational) {
    it(`${name}`, () => {
      expect(behaviour(rebuilt(source))).toEqual(behaviour(source));
    });
  }

  it("a latch keeps what it remembers", () => {
    for (const [source, steps] of [
      [srLatch(), [{ S: 1, R: 0 }, { S: 0, R: 0 }, { S: 0, R: 1 }, { S: 0, R: 0 }, { S: 1, R: 0 }, { S: 0, R: 0 }]],
      [netlist("sr-latch.net"), [{ S: 1, R: 0 }, { S: 0, R: 0 }, { S: 0, R: 1 }, { S: 0, R: 0 }]],
    ] as const) {
      const original = simulationStrategy("sequential").prepare(source);
      const copy = simulationStrategy("sequential").prepare(rebuilt(source));
      let originalState: Record<string, number> | undefined;
      let copyState: Record<string, number> | undefined;
      for (const inputs of steps) {
        const a = original.run(inputs as never, originalState as never);
        const b = copy.run(inputs as never, copyState as never);
        expect(b.outputs).toEqual(a.outputs);
        originalState = a.mode === "sequential" ? (a.state as Record<string, number>) : undefined;
        copyState = b.mode === "sequential" ? (b.state as Record<string, number>) : undefined;
      }
    }
  });

  it("a gated D latch is built again with its loops", () => {
    const spec = specOf(dLatch());
    expect(spec.signals.length).toBeGreaterThan(0);
    expect(buildCircuit(spec).ok).toBe(true);
  });
});
