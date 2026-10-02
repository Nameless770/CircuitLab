import { describe, expect, it } from "vitest";
import fullAdderText from "../../../examples/netlists/full-adder.net?raw";
import halfAdderText from "../../../examples/netlists/half-adder.net?raw";
import srLatchText from "../../../examples/netlists/sr-latch.net?raw";
import type { CircuitData } from "../electron/bridge";
import { checkExport, readNetlist, simulate, toNetlist, toProblem, truthTableCsv, truthTablePage } from "../electron/offline";

const halfAdder = readNetlist(halfAdderText, "fallback");
const latch = readNetlist(srLatchText, "fallback");

/** Catches what `work` throws and turns it into the problem the window would see. */
function problemOf(work: () => unknown): ReturnType<typeof toProblem> {
  try {
    work();
  } catch (error) {
    return toProblem(error);
  }
  throw new Error("expected an error");
}

describe("readNetlist", () => {
  it("reads the circuit and describes it like the API's summary", () => {
    expect(halfAdder.name).toBe("Half adder");
    expect(halfAdder.summary).toEqual({ inputs: ["A", "B"], outputs: ["S", "C"], feedbackLoop: null });
  });

  it("names a netlist without a .name line after its file", () => {
    expect(readNetlist("A = INPUT\nY = OUTPUT(A)\n", "my-file").name).toBe("my-file");
  });

  it("finds the feedback loop of a latch", () => {
    expect(latch.summary.feedbackLoop).not.toBeNull();
    expect(latch.summary.feedbackLoop).toContain("q");
  });

  it("reports netlist mistakes with their line numbers", () => {
    const problem = problemOf(() => readNetlist("A = INPUT\nY = OUTPUT(ghost)\n", "x"));
    expect(problem.code).toBe("invalid-netlist");
    expect(problem.issues?.[0]?.line).toBe(2);
  });
});

describe("simulate", () => {
  it("adds two bits", () => {
    const result = simulate(halfAdder, { inputs: { A: 1, B: 1 }, mode: "combinational" });
    expect(result.outputs).toEqual({ S: 0, C: 1 });
    expect(result.signals["sum"]).toBe(0); // every gate's value, for colouring the wires
    expect(result.state).toBeUndefined();
  });

  it("remembers between steps in sequential mode (an SR latch)", () => {
    const set = simulate(latch, { inputs: { S: 1, R: 0 }, mode: "sequential" });
    expect(set.outputs["out_q"]).toBe(1);
    // Inputs back to 0: the latch keeps its 1, because the state goes into the next step.
    const hold = simulate(latch, { inputs: { S: 0, R: 0 }, mode: "sequential", ...(set.state !== undefined && { state: set.state }) });
    expect(hold.outputs["out_q"]).toBe(1);
  });

  it("refuses a loop in combinational mode, and missing inputs", () => {
    expect(problemOf(() => simulate(latch, { inputs: { S: 0, R: 0 }, mode: "combinational" })).code).toBe("feedback-loop");
    expect(problemOf(() => simulate(halfAdder, { inputs: { A: 1 }, mode: "combinational" })).code).toBe("invalid-inputs");
  });

  it("reports a loop that never settles", () => {
    const ring = readNetlist("a = NOT(b)\nb = NOT(c)\nc = NOT(a)\nY = OUTPUT(a)\n", "ring");
    expect(problemOf(() => simulate(ring, { inputs: {}, mode: "sequential" })).code).toBe("does-not-settle");
  });
});

describe("truth tables", () => {
  it("gives one page of rows", () => {
    const page = truthTablePage(halfAdder, 1, 2);
    expect(page.totalRows).toBe(4);
    expect(page.rows).toEqual([
      { index: 1, inputs: [0, 1], outputs: [1, 0] },
      { index: 2, inputs: [1, 0], outputs: [1, 0] },
    ]);
  });

  it("writes CSV in the same format as the API's download", () => {
    expect([...truthTableCsv(halfAdder)].join("")).toBe("#,A,B,S,C\n0,0,0,0,0\n1,0,1,1,0\n2,1,0,1,0\n3,1,1,0,1\n");
  });

  it("refuses to export more than 1,048,576 rows", () => {
    const gates = Array.from({ length: 21 }, (_, i) => `i${i} = INPUT`).join("\n");
    const big = readNetlist(`${gates}\nY = OUTPUT(i0)\n`, "big");
    expect(problemOf(() => checkExport(big)).code).toBe("too-large");
  });
});

describe("toNetlist", () => {
  it("writes a drawing as netlist text that reads back the same", () => {
    const fullAdder = readNetlist(fullAdderText, "x");
    const data: CircuitData = { name: "Copy", gates: fullAdder.gates, wires: fullAdder.wires };
    const { text, circuit } = toNetlist(data);
    expect(text.startsWith('.name "Copy"\n')).toBe(true);
    expect(circuit.summary.outputs).toEqual(["S", "Cout"]);
    expect(readNetlist(text, "x").gates).toEqual(fullAdder.gates);
  });

  it("lists every mistake in an unfinished drawing, by gate", () => {
    const problem = problemOf(() => toNetlist({ name: "Unfinished", gates: [{ id: "A", type: "INPUT" }, { id: "and1", type: "AND" }], wires: [] }));
    expect(problem.code).toBe("invalid-circuit");
    expect(problem.issues?.some((issue) => issue.gateId === "and1")).toBe(true);
  });
});
