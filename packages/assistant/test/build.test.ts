import { CycleError, compileCircuit, simulationStrategy, truthTable, type Circuit } from "@circuitlab/engine";
import { parseNetlist } from "@circuitlab/netlist";
import { describe, expect, it } from "vitest";
import { buildCircuit, type CircuitSpec, type Definition } from "@circuitlab/assistant";

/** A spec with the boring parts filled in. */
function spec(inputs: string[], outputs: Record<string, string>, signals: Record<string, string> = {}, name = "Test"): CircuitSpec {
  const list = (record: Record<string, string>): Definition[] => Object.entries(record).map(([key, formula]) => ({ name: key, formula }));
  return { name, inputs, signals: list(signals), outputs: list(outputs) };
}

/** Builds the circuit, or fails the test and says why not. */
function build(...args: Parameters<typeof spec>): { netlist: string; circuit: Circuit } {
  const result = buildCircuit(spec(...args));
  if (!result.ok) throw new Error(`could not build the circuit: ${result.problems.join(" | ")}`);
  return result;
}

function problemsOf(...args: Parameters<typeof spec>): readonly string[] {
  const result = buildCircuit(spec(...args));
  if (result.ok) throw new Error(`the circuit was built, but should have had problems:\n${result.netlist}`);
  return result.problems;
}

/** The circuit's outputs for every combination of its inputs, by name. */
function behaviour(circuit: Circuit): { inputs: Record<string, number>; outputs: Record<string, number> }[] {
  const table = truthTable(compileCircuit(circuit), { offset: 0, limit: 4096 });
  return table.rows.map((row) => ({
    inputs: Object.fromEntries(table.inputIds.map((id, index) => [id, row.inputs[index] as number])),
    outputs: Object.fromEntries(table.outputIds.map((id, index) => [id, row.outputs[index] as number])),
  }));
}

/** Every row of the circuit agrees with an ordinary function, and says nothing else. */
function expectBehaviour(circuit: Circuit, reference: (inputs: Record<string, number>) => Record<string, number>): void {
  const rows = behaviour(circuit);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row.outputs, `inputs ${JSON.stringify(row.inputs)}`).toEqual(reference(row.inputs));
}

const countOf = (circuit: Circuit, type: string): number => circuit.gates.filter((gate) => gate.type === type).length;
const bit = (condition: boolean): number => (condition ? 1 : 0);

describe("buildCircuit: circuits from formulas, checked against ordinary code", () => {
  it("a half adder from boolean operators is exactly an XOR and an AND", () => {
    const { circuit } = build(["A", "B"], { SUM: "A ^ B", CARRY: "A & B" });
    expectBehaviour(circuit, (v) => ({ SUM: v.A! ^ v.B!, CARRY: v.A! & v.B! }));
    expect(circuit.gates.map((gate) => gate.type).sort()).toEqual(["AND", "INPUT", "INPUT", "OUTPUT", "OUTPUT", "XOR"]);
  });

  it("a full adder: one XOR with three inputs for the sum, and the majority for the carry", () => {
    const { circuit, netlist } = build(["A", "B", "CIN"], { SUM: "A ^ B ^ CIN", COUT: "A + B + CIN >= 2" });
    expectBehaviour(circuit, (v) => ({ SUM: v.A! ^ v.B! ^ v.CIN!, COUT: bit(v.A! + v.B! + v.CIN! >= 2) }));
    expect(netlist).toMatch(/^xor1 = XOR\(A, B, CIN\)$/m);
    expect(countOf(circuit, "XOR")).toBe(1);
  });

  it("a multiplexer written with ? : comes out as the textbook four gates", () => {
    const { circuit } = build(["D0", "D1", "SEL"], { Y: "SEL ? D1 : D0" });
    expectBehaviour(circuit, (v) => ({ Y: v.SEL! ? v.D1! : v.D0! }));
    expect([countOf(circuit, "NOT"), countOf(circuit, "AND"), countOf(circuit, "OR")]).toEqual([1, 2, 1]);
  });

  it("a majority, however it's written", () => {
    for (const formula of ["(A & B) | (A & C) | (B & C)", "A + B + C >= 2", "AND(OR(A, B), OR(A, C), OR(B, C))", "(A + B + C) / 2 >= 1"]) {
      const { circuit } = build(["A", "B", "C"], { Y: formula });
      expectBehaviour(circuit, (v) => ({ Y: bit(v.A! + v.B! + v.C! >= 2) }));
    }
  });

  it("a decoder written with arithmetic", () => {
    const outputs = Object.fromEntries([0, 1, 2, 3].map((n) => [`Y${n}`, `A1 * 2 + A0 == ${n}`]));
    const { circuit } = build(["A1", "A0"], outputs);
    expectBehaviour(circuit, (v) => Object.fromEntries([0, 1, 2, 3].map((n) => [`Y${n}`, bit(v.A1! * 2 + v.A0! === n)])));
    expect(countOf(circuit, "NOT")).toBe(2); // one inverter for each input, shared by all four outputs
  });

  it("a comparator: == is an XNOR, and > an AND with an inverter", () => {
    const { circuit } = build(["A", "B"], { GT: "A > B", EQ: "A == B", LT: "A < B" });
    expectBehaviour(circuit, (v) => ({ GT: bit(v.A! > v.B!), EQ: bit(v.A! === v.B!), LT: bit(v.A! < v.B!) }));
    expect(countOf(circuit, "XNOR")).toBe(1);
  });

  it("parity is one XOR or XNOR, not a pile of products", () => {
    const even = build(["A", "B", "C", "D"], { P: "(A + B + C + D) % 2 == 0" });
    expectBehaviour(even.circuit, (v) => ({ P: bit((v.A! + v.B! + v.C! + v.D!) % 2 === 0) }));
    expect(even.circuit.gates.filter((gate) => gate.type !== "INPUT" && gate.type !== "OUTPUT").map((gate) => gate.type)).toEqual(["XNOR"]);
    const odd = build(["A", "B", "C"], { P: "(A + B + C) % 2" });
    expect(countOf(odd.circuit, "XOR")).toBe(1);
  });

  it("a 2-bit adder, from one arithmetic formula per output", () => {
    const sum = "2 * A1 + A0 + 2 * B1 + B0";
    const { circuit } = build(["A1", "A0", "B1", "B0"], { S2: `(${sum}) / 4 % 2`, S1: `(${sum}) / 2 % 2`, S0: `(${sum}) % 2` });
    expectBehaviour(circuit, (v) => {
      const total = v.A1! * 2 + v.A0! + v.B1! * 2 + v.B0!;
      return { S2: (total >> 2) & 1, S1: (total >> 1) & 1, S0: total & 1 };
    });
  });

  it("works out a table of 8 inputs, whose answer needs more than 64 products", () => {
    const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const total = names.join(" + ");
    // Odd parity, except that "all ones" also counts: 128 products that can't be joined, and 8 that can.
    const { circuit, netlist } = build(names, { Y: `(${total}) % 2 + ((${total}) == 8) >= 1` });
    expectBehaviour(circuit, (v) => {
      const ones = names.reduce((count, name) => count + v[name]!, 0);
      return { Y: bit(ones % 2 === 1 || ones === 8) };
    });
    const widest = Math.max(...circuit.wires.map((wire) => wire.toPin)) + 1;
    expect(widest).toBeLessThanOrEqual(64);
    expect(netlist.split("\n").some((line) => /^or\d+ = OR\(/.test(line))).toBe(true);
  });

  it("outputs can be a constant, an input, or its opposite", () => {
    const { circuit } = build(["A"], { ONE: "1", ZERO: "0", SAME: "A", OPPOSITE: "!A", CONSTANT_ARITHMETIC: "1 + 1 >= 2" });
    expectBehaviour(circuit, (v) => ({ ONE: 1, ZERO: 0, SAME: v.A!, OPPOSITE: 1 - v.A!, CONSTANT_ARITHMETIC: 1 }));
  });

  it("signals name a value that several formulas use, and the gate keeps the signal's name", () => {
    const { circuit, netlist } = build(["A", "B", "CIN"], { SUM: "x ^ CIN", COUT: "(A & B) | (x & CIN)" }, { x: "A ^ B" });
    expectBehaviour(circuit, (v) => ({ SUM: v.A! ^ v.B! ^ v.CIN!, COUT: bit(v.A! + v.B! + v.CIN! >= 2) }));
    expect(netlist).toMatch(/^x = XOR\(A, B\)$/m);
  });

  it("the same gate is built once, however many formulas want it", () => {
    const { circuit } = build(["A", "B"], { P: "!A & B", Q: "!A & !B", R: "NOT(A) | B" });
    expect(countOf(circuit, "NOT")).toBe(2);
  });

  it("a latch: signals that use each other in a loop remember a bit", () => {
    const { circuit } = build(["S", "R"], { Q: "q", QBAR: "qbar" }, { q: "NOR(R, qbar)", qbar: "NOR(S, q)" });
    expect(() => compileCircuit(circuit)).toThrow(CycleError); // a feedback loop: no truth table
    const latch = simulationStrategy("sequential").prepare(circuit);
    const set = latch.run({ S: 1, R: 0 });
    expect(set.outputs).toEqual({ Q: 1, QBAR: 0 });
    const held = latch.run({ S: 0, R: 0 }, set.mode === "sequential" ? set.state : undefined);
    expect(held.outputs).toEqual({ Q: 1, QBAR: 0 }); // the inputs went back to 0, the output stayed
    const reset = latch.run({ S: 0, R: 1 }, held.mode === "sequential" ? held.state : undefined);
    expect(reset.outputs).toEqual({ Q: 0, QBAR: 1 });
  });

  it("never reuses a name that is already taken", () => {
    const { netlist, circuit } = build(["and1", "B"], { Y: "and1 & B" });
    expect(netlist).toMatch(/^and2 = AND\(and1, B\)$/m);
    expect(parseNetlist(netlist)).toEqual(circuit);
  });

  it("names the circuit, in a form a netlist can hold", () => {
    expect(build(["A"], { Y: "A" }, {}, "  Half \"adder\"\n").netlist.split("\n")[0]).toBe('.name "Half \\"adder\\""');
    expect(build(["A"], { Y: "A" }, {}, "").circuit.name).toBe("Circuit");
    expect(build(["A"], { Y: "A" }, {}, "x".repeat(200)).circuit.name).toHaveLength(60);
  });

  it("gives a netlist the netlist reader accepts, and the same circuit back", () => {
    const { netlist, circuit } = build(["A", "B"], { Y: "A ^ B" });
    expect(netlist.endsWith("\n")).toBe(true);
    expect(parseNetlist(netlist)).toEqual(circuit);
  });
});

describe("buildCircuit: problems, in words that tell the model what to fix", () => {
  it("says which formula can't be read, and shows it", () => {
    const [problem] = problemsOf(["A", "B"], { SUM: "A ^ (B", CARRY: "A & B" });
    expect(problem).toBe("The formula for “SUM” can't be read: a “(” needs a “)” to close it, but found the end of the formula. The formula was: A ^ (B");
  });

  it("finds a name that doesn't exist", () => {
    expect(problemsOf(["A"], { Y: "A & B" })).toEqual(["The formula for “Y” uses “B”, but there is no input or signal with that name."]);
  });

  it("refuses an output used inside a formula", () => {
    expect(problemsOf(["A"], { X: "A", Y: "!X" })[0]).toMatch(/uses “X”, which is an output.*use an input or a signal/);
  });

  it("refuses names that clash, or that can't be names", () => {
    expect(problemsOf(["A", "A"], { Y: "A" })[0]).toMatch(/“A” is used twice \(as an input and as an input\)/);
    expect(problemsOf(["A"], { A: "1" })[0]).toMatch(/“A” is used twice \(as an input and as an output\)/);
    expect(problemsOf(["A"], { Y: "A" }, { Y: "!A" })[0]).toMatch(/“Y” is used twice \(as a signal and as an output\)/);
    expect(problemsOf(["1A"], { Y: "1" })[0]).toMatch(/“1A” can't be used as the name of an input: names start with a letter/);
    expect(problemsOf(["A B"], { Y: "1" })[0]).toMatch(/can't be used as the name of an input/);
    expect(problemsOf(["and"], { Y: "1" })[0]).toMatch(/“and” can't be the name of an input: in formulas it means an operator/);
    expect(problemsOf(["XOR"], { Y: "1" })[0]).toMatch(/means an operator/);
  });

  it("wants inputs and outputs", () => {
    expect(problemsOf([], { Y: "1" })).toContain("The circuit has no inputs.");
    expect(problemsOf(["A"], {})[0]).toMatch(/no outputs/);
    const many = Array.from({ length: 17 }, (_, index) => `I${index}`);
    expect(problemsOf(many, { Y: "I0" })[0]).toBe("The circuit has 17 inputs; the most the assistant builds is 16.");
  });

  it("counts the inputs of a gate function", () => {
    expect(problemsOf(["A", "B"], { Y: "NOT(A, B)" })[0]).toBe("NOT needs exactly one input, but NOT(A, B) in the formula for “Y” has 2.");
    expect(problemsOf(["A", "B"], { Y: "AND(A)" })[0]).toBe("AND needs at least two inputs, but AND(A) in the formula for “Y” has 1.");
  });

  it("explains a number that isn't 0 or 1, and how to fix it", () => {
    expect(problemsOf(["A", "B"], { Y: "A + B" })[0]).toBe(
      "The part A + B of the formula for “Y” gives 2 when A=1 B=1, but only 0 and 1 are allowed. To count something, compare it: write A + B >= 1 instead of A + B.",
    );
    expect(problemsOf(["A"], { Y: "2 + 2" })[0]).toMatch(/gives 4 always/);
  });

  it("keeps arithmetic on inputs: a signal inside it is refused", () => {
    expect(problemsOf(["A", "B"], { Y: "q + A >= 1" }, { q: "A & B" })[0]).toBe(
      "The formula for “Y” uses the signal “q” inside (q + A) >= 1. Arithmetic, comparisons and ? : work on inputs only; on signals use & | ^ !.",
    );
  });

  it("limits how many inputs one table may depend on", () => {
    const names = Array.from({ length: 9 }, (_, index) => `I${index}`);
    expect(problemsOf(names, { Y: `${names.join(" + ")} >= 5` })[0]).toMatch(/depends on 9 inputs; the assistant can work out at most 8 at a time/);
  });

  it("reports a division by zero", () => {
    expect(problemsOf(["A"], { Y: "A / (A - A)" })[0]).toBe("The formula for “Y” can't be worked out: it divides by zero.");
  });

  it("reports every problem at once, so the model can fix them together", () => {
    const problems = problemsOf(["A", "B"], { X: "A & C", Y: "A ^ ", Z: "NOT(A, B)" });
    expect(problems).toHaveLength(3);
  });
});
