import { compileCircuit, simulationStrategy, truthTable, type Circuit } from "@circuitlab/engine";
import { describe, expect, it } from "vitest";
import { EXAMPLES_PER_PROMPT, RECIPES, buildCircuit, recipesFor, requestProblems } from "@circuitlab/assistant";

type Values = Record<string, number>;
const bit = (condition: boolean): number => (condition ? 1 : 0);

/** Every row of the circuit's truth table agrees with ordinary code, or says what doesn't. */
function wrongRow(circuit: Circuit, reference: (v: Values) => Values, onlyGates?: string[]): string | undefined {
  if (onlyGates !== undefined) {
    const other = circuit.gates.map((gate) => gate.type).find((type) => type !== "INPUT" && type !== "OUTPUT" && !onlyGates.includes(type));
    if (other !== undefined) return `uses ${other}`;
  }
  const table = truthTable(compileCircuit(circuit), { offset: 0, limit: 4096 });
  for (const row of table.rows) {
    const inputs: Values = Object.fromEntries(table.inputIds.map((id, index) => [id, row.inputs[index] as number]));
    const wanted = reference(inputs);
    const got: Values = Object.fromEntries(table.outputIds.map((id, index) => [id, row.outputs[index] as number]));
    if (JSON.stringify(Object.entries(got).sort()) !== JSON.stringify(Object.entries(wanted).sort())) return `inputs ${JSON.stringify(inputs)}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(wanted)}`;
  }
  return undefined;
}

/** Steps of a circuit with memory: what goes in, and what must come out. */
function remembers(circuit: Circuit, steps: { inputs: Values; outputs: Values }[]): string | undefined {
  const run = simulationStrategy("sequential").prepare(circuit);
  let state: Values | undefined;
  for (const step of steps) {
    const result = run.run(step.inputs as never, state as never);
    if (JSON.stringify(Object.entries(result.outputs).sort()) !== JSON.stringify(Object.entries(step.outputs).sort())) return `after ${JSON.stringify(step.inputs)}: got ${JSON.stringify(result.outputs)}, wanted ${JSON.stringify(step.outputs)}`;
    state = result.mode === "sequential" ? (result.state as Values) : undefined;
  }
  return undefined;
}

/** What each recipe must do. A recipe without an entry here fails the test below. */
const CHECKS: Record<string, (circuit: Circuit) => string | undefined> = {
  "half-adder": (c) => wrongRow(c, (v) => ({ SUM: v.A! ^ v.B!, CARRY: v.A! & v.B! })),
  "full-adder": (c) => wrongRow(c, (v) => ({ SUM: v.A! ^ v.B! ^ v.CIN!, COUT: bit(v.A! + v.B! + v.CIN! >= 2) })),
  "adder-2bit": (c) =>
    wrongRow(c, (v) => {
      const sum = v.A1! * 2 + v.A0! + v.B1! * 2 + v.B0!;
      return { S2: (sum >> 2) & 1, S1: (sum >> 1) & 1, S0: sum & 1 };
    }),
  subtractor: (c) => wrongRow(c, (v) => ({ DIFF: v.A! ^ v.B!, BORROW: bit(v.A === 0 && v.B === 1) })),
  "mux-2to1": (c) => wrongRow(c, (v) => ({ Y: v.SEL! ? v.D1! : v.D0! })),
  "mux-4to1": (c) => wrongRow(c, (v) => ({ Y: [v.D0!, v.D1!, v.D2!, v.D3!][v.S1! * 2 + v.S0!]! })),
  "decoder-2to4": (c) => wrongRow(c, (v) => Object.fromEntries([0, 1, 2, 3].map((n) => [`Y${n}`, bit(v.A1! * 2 + v.A0! === n)]))),
  "comparator-1bit": (c) => wrongRow(c, (v) => ({ GT: bit(v.A! > v.B!), EQ: bit(v.A === v.B), LT: bit(v.A! < v.B!) })),
  "equal-2bit": (c) => wrongRow(c, (v) => ({ EQ: bit(v.A1! * 2 + v.A0! === v.B1! * 2 + v.B0!) })),
  majority: (c) => wrongRow(c, (v) => ({ M: bit(v.A! + v.B! + v.C! >= 2) })),
  threshold: (c) => wrongRow(c, (v) => ({ Y: bit(v.A! + v.B! + v.C! + v.D! === 2) })),
  parity: (c) => wrongRow(c, (v) => ({ P: bit((v.A! + v.B! + v.C! + v.D!) % 2 === 0) })),
  "sr-latch": (c) =>
    remembers(c, [
      { inputs: { S: 1, R: 0 }, outputs: { Q: 1, QBAR: 0 } },
      { inputs: { S: 0, R: 0 }, outputs: { Q: 1, QBAR: 0 } },
      { inputs: { S: 0, R: 1 }, outputs: { Q: 0, QBAR: 1 } },
      { inputs: { S: 0, R: 0 }, outputs: { Q: 0, QBAR: 1 } },
    ]),
  "d-latch": (c) =>
    remembers(c, [
      { inputs: { D: 1, EN: 1 }, outputs: { Q: 1, QBAR: 0 } },
      { inputs: { D: 0, EN: 0 }, outputs: { Q: 1, QBAR: 0 } }, // closed: D is ignored
      { inputs: { D: 0, EN: 1 }, outputs: { Q: 0, QBAR: 1 } },
      { inputs: { D: 1, EN: 0 }, outputs: { Q: 0, QBAR: 1 } },
    ]),
  "xor-from-nand": (c) => wrongRow(c, (v) => ({ Y: v.A! ^ v.B! }), ["NAND"]),
  expression: (c) => wrongRow(c, (v) => ({ Y: bit((v.A === 1 && v.B === 0) || v.C === 1) })),
};

describe("the recipes in the prompt", () => {
  it("every recipe has a check, and every check a recipe", () => {
    expect(Object.keys(CHECKS).sort()).toEqual(RECIPES.map((recipe) => recipe.id).sort());
  });

  for (const recipe of RECIPES) {
    it(`${recipe.id}: builds, and does what its request says`, () => {
      const built = buildCircuit(recipe.spec);
      if (!built.ok) throw new Error(built.problems.join(" | "));
      expect(CHECKS[recipe.id]?.(built.circuit)).toBeUndefined();
    });

    it(`${recipe.id}: passes the checks made on every answer, so the model isn't shown what would be sent back`, () => {
      const built = buildCircuit(recipe.spec);
      if (!built.ok) throw new Error(built.problems.join(" | "));
      expect(requestProblems(recipe.request, built.circuit)).toEqual([]);
    });

    it(`${recipe.id}: its request mentions every input and output it uses, so the example makes sense`, () => {
      for (const name of [...recipe.spec.inputs, ...recipe.spec.outputs.map((output) => output.name)]) {
        expect(recipe.request, `“${name}” in ${recipe.id}`).toContain(name);
      }
    });
  }

  it("have ids that are all different, and a sentence for the idea", () => {
    expect(new Set(RECIPES.map((recipe) => recipe.id)).size).toBe(RECIPES.length);
    for (const recipe of RECIPES) expect(recipe.idea.length).toBeGreaterThan(20);
  });
});

describe("recipesFor: the examples a request gets", () => {
  const idsFor = (request: string): string[] => recipesFor(request).map((recipe) => recipe.id);

  it("starts with the recipe the request names", () => {
    expect(idsFor("Make me a full adder please")[0]).toBe("full-adder");
    expect(idsFor("a half adder")[0]).toBe("half-adder");
    expect(idsFor("A 4-to-1 multiplexer")[0]).toBe("mux-4to1");
    expect(idsFor("a 2:1 mux with select S")[0]).toBe("mux-2to1");
    expect(idsFor("3-bit DECODER")[0]).toBe("decoder-2to4");
    expect(idsFor("an SR latch from NOR gates")[0]).toBe("sr-latch");
    expect(idsFor("XOR using only NAND gates")[0]).toBe("xor-from-nand");
  });

  it("always gives the same number of different examples, whatever is asked", () => {
    for (const request of ["a full adder", "something strange", "", "adder adder adder mux latch decoder parity majority"]) {
      const ids = idsFor(request);
      expect(ids).toHaveLength(EXAMPLES_PER_PROMPT);
      expect(new Set(ids).size).toBe(EXAMPLES_PER_PROMPT);
    }
  });

  it("falls back to one example of each way of writing a formula when nothing matches", () => {
    expect(idsFor("qwertyuiop")).toEqual(["majority", "mux-2to1", "expression"]);
  });

  it("puts the closest first when several match", () => {
    // "full adder" (10 letters) outweighs "adder" and "carry" on their own.
    expect(idsFor("a full adder with a carry")[0]).toBe("full-adder");
  });
});
