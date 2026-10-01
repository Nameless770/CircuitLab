import { CircuitValidationError, CompiledCircuit, CycleError, SimulationInputError, compileCircuit, simulate, type InputIssue } from "@circuitlab/engine";
import { describe, expect, it } from "vitest";
import { circuit, fullAdder, halfAdder, srLatch } from "./fixtures";

function inputIssues(run: () => unknown): Omit<InputIssue, "message">[] {
  try {
    run();
  } catch (error) {
    if (error instanceof SimulationInputError) return error.issues.map(({ message: _, ...rest }) => rest);
    throw error;
  }
  throw new Error("expected a SimulationInputError");
}

describe("simulate", () => {
  it("returns the OUTPUT values, every gate's signal, and the evaluation order", () => {
    const result = simulate(fullAdder(), { A: 1, B: 0, Cin: 1 });
    expect(result.outputs).toEqual({ S: 0, Cout: 1 });
    expect(result.signals).toMatchObject({ A: 1, B: 0, Cin: 1, parity: 0, ab: 0, ac: 1, bc: 0, majority: 1 });
    expect(result.order).toEqual(compileCircuit(fullAdder()).order);
  });

  it("drives logic from CONST gates", () => {
    const source = circuit("constants", ["A", "INPUT"], ["one", "CONST1"], ["x", "XOR", "A", "one"], ["Y", "OUTPUT", "x"]);
    expect(simulate(source, { A: 0 }).outputs).toEqual({ Y: 1 });
    expect(simulate(source, { A: 1 }).outputs).toEqual({ Y: 0 });
  });

  it("refuses invalid circuits and circuits with a feedback loop", () => {
    expect(() => simulate({ gates: [{ id: "A", type: "INPUT" }, { id: "A", type: "INPUT" }], wires: [] } as never, {})).toThrow(CircuitValidationError);
    expect(() => simulate(srLatch(), { S: 0, R: 0 })).toThrow(CycleError);
  });
});

describe("simulation inputs are checked, all at once", () => {
  it("reports missing and unknown inputs", () => {
    expect(inputIssues(() => simulate(halfAdder(), { A: 1, C: 0 }))).toEqual([
      { code: "MISSING_INPUT", inputId: "B" },
      { code: "UNKNOWN_INPUT", inputId: "C" },
    ]);
  });

  it.each([2, -1, "1", true, null, 0.5])("refuses %j as a value", (value) => {
    expect(inputIssues(() => simulate(halfAdder(), { A: value as never, B: 0 }))).toEqual([{ code: "INVALID_INPUT_VALUE", inputId: "A" }]);
  });

  it.each([null, undefined, [1, 0], "A=1"])("refuses %j as the inputs object", (inputs) => {
    expect(inputIssues(() => simulate(halfAdder(), inputs as never))).toEqual([{ code: "MALFORMED_INPUTS" }]);
  });

  it("ignores inherited properties: only the object's own keys count", () => {
    const inputs = Object.create({ B: 1 }) as Record<string, 0 | 1>;
    inputs.A = 1;
    expect(inputIssues(() => simulate(halfAdder(), inputs))).toEqual([{ code: "MISSING_INPUT", inputId: "B" }]);
  });
});

describe("compileCircuit", () => {
  it("validates and sorts once; the result simulates any number of times", () => {
    const compiled = compileCircuit(halfAdder());
    expect(compiled).toBeInstanceOf(CompiledCircuit);
    expect(compiled.inputIds).toEqual(["A", "B"]);
    expect(compiled.outputIds).toEqual(["S", "C"]);
    expect([0, 1].flatMap((a) => [0, 1].map((b) => simulate(compiled, { A: a as 0 | 1, B: b as 0 | 1 }).outputs))).toEqual([
      { S: 0, C: 0 },
      { S: 1, C: 0 },
      { S: 1, C: 0 },
      { S: 0, C: 1 },
    ]);
  });

  it("keeps its own copy: changing the source afterwards changes nothing", () => {
    const source = halfAdder();
    const compiled = compileCircuit(source);
    (source.gates as unknown as { type: string }[])[2]!.type = "XNOR"; // sum = XOR(A, B), now XNOR in the source
    expect(simulate(compiled, { A: 0, B: 0 }).outputs.S).toBe(0);
    expect(simulate(source, { A: 0, B: 0 }).outputs.S).toBe(1);
  });

  it("is never fooled by data shaped like a compiled circuit", () => {
    const forged = JSON.parse(JSON.stringify(compileCircuit(halfAdder()))) as unknown;
    expect(() => simulate(forged as never, { A: 1, B: 1 })).toThrow(CircuitValidationError);
  });

  it("treats gate ids like __proto__ as ordinary keys in the results", () => {
    const source = circuit("tricky ids", ["__proto__", "INPUT"], ["constructor", "NOT", "__proto__"], ["toString", "OUTPUT", "constructor"]);
    const result = simulate(source, JSON.parse('{"__proto__": 1}'));
    expect(Object.keys(result.outputs)).toEqual(["toString"]);
    expect(result.outputs.toString).toBe(0);
    expect(Object.getOwnPropertyDescriptor(result.signals, "__proto__")?.value).toBe(1);
    expect(Object.getPrototypeOf(result.signals)).toBe(Object.prototype);
  });
});
