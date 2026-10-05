/**
 * How good is the assistant, with the model you have? Asks Ollama for a set of circuits, runs the
 * whole assistant (prompt, retries, builder), and checks each answer against ordinary code.
 * Not part of `npm test`: it needs Ollama running, and takes a few minutes.
 *
 *   npm run eval:assistant                     the model Ollama lists first
 *   npm run eval:assistant -- llama3.2:3b      a model by name
 *
 * The numbers in docs/assistant.md come from this script. Three groups of requests:
 *   cookbook  things a recipe in the prompt is close to, but worded differently and with other names
 *   unseen    things no recipe covers
 *   change    "change this circuit" requests
 */
import { CycleError, compileCircuit, simulationStrategy, truthTable, type Circuit } from "@circuitlab/engine";
import { parseNetlist } from "@circuitlab/netlist";
import { AssistantError, OllamaClient, describeCircuit, designCircuit, listModels } from "@circuitlab/assistant";

type Group = "cookbook" | "unseen" | "change";

interface Task {
  readonly name: string;
  readonly group: Group;
  readonly request: string;
  /** The circuit to change, as a netlist. */
  readonly current?: string;
  /** What is wrong with the circuit, or undefined when it is right. */
  readonly check: (circuit: Circuit) => string | undefined;
}

const bit = (condition: boolean): number => (condition ? 1 : 0);

/** A circuit with a truth table: its inputs, its outputs, and every row agree with `reference`. */
function behaves(inputs: string[], outputs: string[], reference: (v: Record<string, number>) => Record<string, number>, onlyGates?: string[]): Task["check"] {
  return (circuit) => {
    if (onlyGates !== undefined) {
      const other = circuit.gates.map((gate) => gate.type).find((type) => type !== "INPUT" && type !== "OUTPUT" && !onlyGates.includes(type));
      if (other !== undefined) return `uses a ${other} gate, but only ${onlyGates.join("/")} gates were allowed`;
    }
    let table;
    try {
      table = truthTable(compileCircuit(circuit), { offset: 0, limit: 4096 });
    } catch (error) {
      return error instanceof CycleError ? "has a feedback loop" : String(error);
    }
    const sameNames = (actual: readonly string[], wanted: readonly string[]): boolean => actual.length === wanted.length && wanted.every((name) => actual.includes(name));
    if (!sameNames(table.inputIds, inputs)) return `inputs are ${table.inputIds.join(",")}, not ${inputs.join(",")}`;
    if (!sameNames(table.outputIds, outputs)) return `outputs are ${table.outputIds.join(",")}, not ${outputs.join(",")}`;
    for (const row of table.rows) {
      const values = Object.fromEntries(table.inputIds.map((id, index) => [id, row.inputs[index] as number]));
      const expected = reference(values);
      for (const [index, id] of table.outputIds.entries()) {
        if (row.outputs[index] !== expected[id]) return `${id} is ${row.outputs[index]} for ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(" ")}, should be ${expected[id]}`;
      }
    }
    return undefined;
  };
}

/** A circuit with memory: steps of inputs, and the outputs expected after each. */
function remembers(steps: { inputs: Record<string, number>; outputs: Record<string, number> }[]): Task["check"] {
  return (circuit) => {
    const run = simulationStrategy("sequential").prepare(circuit);
    let state: Record<string, number> | undefined;
    for (const step of steps) {
      let result;
      try {
        result = run.run(step.inputs as never, state as never);
      } catch (error) {
        return `can't be simulated: ${error instanceof Error ? error.message : String(error)}`;
      }
      for (const [id, wanted] of Object.entries(step.outputs)) {
        if ((result.outputs as Record<string, number>)[id] !== wanted) return `${id} is ${(result.outputs as Record<string, number>)[id]} after ${JSON.stringify(step.inputs)}, should be ${wanted}`;
      }
      state = result.mode === "sequential" ? (result.state as Record<string, number>) : undefined;
    }
    return undefined;
  };
}

const total = (v: Record<string, number>, names: string[]): number => names.reduce((sum, name) => sum + (v[name] ?? 0), 0);

const TASKS: readonly Task[] = [
  // --- cookbook: close to a recipe, worded differently, with other names
  { group: "cookbook", name: "half adder", request: "Build a half adder. The inputs are X and Y, and the outputs are S and C.", check: behaves(["X", "Y"], ["S", "C"], (v) => ({ S: v.X! ^ v.Y!, C: v.X! & v.Y! })) },
  { group: "cookbook", name: "full adder", request: "Make a full adder with inputs X, Y and CARRY_IN and outputs S and CARRY_OUT.", check: behaves(["X", "Y", "CARRY_IN"], ["S", "CARRY_OUT"], (v) => ({ S: v.X! ^ v.Y! ^ v.CARRY_IN!, CARRY_OUT: bit(total(v, ["X", "Y", "CARRY_IN"]) >= 2) })) },
  {
    group: "cookbook",
    name: "2-bit adder",
    request: "An adder for two 2-bit numbers: inputs X1 X0 and Y1 Y0, outputs T2 T1 T0 for the total.",
    check: behaves(["X1", "X0", "Y1", "Y0"], ["T2", "T1", "T0"], (v) => {
      const sum = v.X1! * 2 + v.X0! + v.Y1! * 2 + v.Y0!;
      return { T2: (sum >> 2) & 1, T1: (sum >> 1) & 1, T0: sum & 1 };
    }),
  },
  { group: "cookbook", name: "half subtractor", request: "A half subtractor that computes P minus Q: inputs P and Q, outputs D (the difference) and B (the borrow).", check: behaves(["P", "Q"], ["D", "B"], (v) => ({ D: v.P! ^ v.Q!, B: bit(v.P === 0 && v.Q === 1) })) },
  { group: "cookbook", name: "2-to-1 mux", request: "A 2:1 multiplexer: inputs A, B and S, output Y. Y is B when S is 1 and A when S is 0.", check: behaves(["A", "B", "S"], ["Y"], (v) => ({ Y: v.S ? v.B! : v.A! })) },
  {
    group: "cookbook",
    name: "4-to-1 mux",
    request: "A 4-to-1 multiplexer with data inputs I0 I1 I2 I3, select inputs SA and SB (SA is the high bit), and output OUT.",
    check: behaves(["I0", "I1", "I2", "I3", "SA", "SB"], ["OUT"], (v) => ({ OUT: [v.I0!, v.I1!, v.I2!, v.I3!][v.SA! * 2 + v.SB!]! })),
  },
  {
    group: "cookbook",
    name: "2-to-4 decoder",
    request: "A 2-to-4 decoder: inputs P and Q (P is the high bit), outputs O0, O1, O2 and O3. Output On is 1 when PQ is the number n.",
    check: behaves(["P", "Q"], ["O0", "O1", "O2", "O3"], (v) => Object.fromEntries([0, 1, 2, 3].map((n) => [`O${n}`, bit(v.P! * 2 + v.Q! === n)]))),
  },
  { group: "cookbook", name: "1-bit comparator", request: "Compare two bits A and B: output BIGGER when A > B, SAME when A = B, SMALLER when A < B.", check: behaves(["A", "B"], ["BIGGER", "SAME", "SMALLER"], (v) => ({ BIGGER: bit(v.A! > v.B!), SAME: bit(v.A! === v.B!), SMALLER: bit(v.A! < v.B!) })) },
  {
    group: "cookbook",
    name: "2-bit equality",
    request: "Output MATCH is 1 when the 2-bit number A1A0 equals the 2-bit number C1C0. Inputs A1, A0, C1, C0.",
    check: behaves(["A1", "A0", "C1", "C0"], ["MATCH"], (v) => ({ MATCH: bit(v.A1! * 2 + v.A0! === v.C1! * 2 + v.C0!) })),
  },
  { group: "cookbook", name: "majority of 3", request: "A voter: inputs V1, V2 and V3, output WIN is 1 when at least two of them are 1.", check: behaves(["V1", "V2", "V3"], ["WIN"], (v) => ({ WIN: bit(total(v, ["V1", "V2", "V3"]) >= 2) })) },
  { group: "cookbook", name: "even parity of 4", request: "Inputs W, X, Y, Z. Output EVEN is 1 when an even number of the inputs are 1.", check: behaves(["W", "X", "Y", "Z"], ["EVEN"], (v) => ({ EVEN: bit(total(v, ["W", "X", "Y", "Z"]) % 2 === 0) })) },
  { group: "cookbook", name: "exactly two of four", request: "Inputs A, B, C, D. Output TWO is 1 when exactly two inputs are 1.", check: behaves(["A", "B", "C", "D"], ["TWO"], (v) => ({ TWO: bit(total(v, ["A", "B", "C", "D"]) === 2) })) },
  {
    group: "cookbook",
    name: "SR latch",
    request: "A set-reset latch made of two NOR gates. Inputs SET and RESET, outputs Q and NQ.",
    check: remembers([
      { inputs: { SET: 1, RESET: 0 }, outputs: { Q: 1, NQ: 0 } },
      { inputs: { SET: 0, RESET: 0 }, outputs: { Q: 1, NQ: 0 } },
      { inputs: { SET: 0, RESET: 1 }, outputs: { Q: 0, NQ: 1 } },
      { inputs: { SET: 0, RESET: 0 }, outputs: { Q: 0, NQ: 1 } },
    ]),
  },
  {
    group: "cookbook",
    name: "gated D latch",
    request: "A gated D latch from NAND gates. Inputs DATA and ENABLE, outputs Q and QN.",
    check: remembers([
      { inputs: { DATA: 1, ENABLE: 1 }, outputs: { Q: 1, QN: 0 } },
      { inputs: { DATA: 0, ENABLE: 0 }, outputs: { Q: 1, QN: 0 } },
      { inputs: { DATA: 0, ENABLE: 1 }, outputs: { Q: 0, QN: 1 } },
      { inputs: { DATA: 1, ENABLE: 0 }, outputs: { Q: 0, QN: 1 } },
    ]),
  },
  { group: "cookbook", name: "XOR from NANDs", request: "Make an XOR gate using only NAND gates. Inputs A and B, output Y.", check: behaves(["A", "B"], ["Y"], (v) => ({ Y: v.A! ^ v.B! }), ["NAND"]) },
  { group: "cookbook", name: "expression", request: "Inputs P, Q, R. Output Z = (P or Q) and not R.", check: behaves(["P", "Q", "R"], ["Z"], (v) => ({ Z: bit((v.P! === 1 || v.Q! === 1) && v.R === 0) })) },

  // --- unseen: no recipe covers these
  {
    group: "unseen",
    name: "3-to-8 decoder",
    request: "A 3-to-8 decoder with inputs A2 A1 A0 (A2 is the high bit) and outputs Y0 to Y7. Output Yn is 1 only when the number A2A1A0 is n.",
    check: behaves(["A2", "A1", "A0"], ["Y0", "Y1", "Y2", "Y3", "Y4", "Y5", "Y6", "Y7"], (v) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map((n) => [`Y${n}`, bit(v.A2! * 4 + v.A1! * 2 + v.A0! === n)]))),
  },
  { group: "unseen", name: "3 of 5", request: "Inputs A B C D E, output Y is 1 when at least three of the inputs are 1.", check: behaves(["A", "B", "C", "D", "E"], ["Y"], (v) => ({ Y: bit(total(v, ["A", "B", "C", "D", "E"]) >= 3) })) },
  {
    group: "unseen",
    name: "full subtractor",
    request: "A full subtractor computing A minus B minus BIN. Inputs A, B and BIN, outputs DIFF and BOUT (the borrow out).",
    check: behaves(["A", "B", "BIN"], ["DIFF", "BOUT"], (v) => ({ DIFF: (v.A! - v.B! - v.BIN! + 2) % 2, BOUT: bit(v.A! - v.B! - v.BIN! < 0) })),
  },
  {
    group: "unseen",
    name: "2-bit greater-than",
    request: "Inputs A1 A0 and B1 B0 (the 2-bit numbers A and B). Output GT is 1 when the number A is greater than the number B.",
    check: behaves(["A1", "A0", "B1", "B0"], ["GT"], (v) => ({ GT: bit(v.A1! * 2 + v.A0! > v.B1! * 2 + v.B0!) })),
  },
  { group: "unseen", name: "XNOR from NORs", request: "Make an XNOR gate using only NOR gates. Inputs A and B, output Y.", check: behaves(["A", "B"], ["Y"], (v) => ({ Y: bit(v.A === v.B) }), ["NOR"]) },
  { group: "unseen", name: "1-of-3 detector", request: "Inputs A, B, C. Output ONE is 1 when exactly one of the inputs is 1.", check: behaves(["A", "B", "C"], ["ONE"], (v) => ({ ONE: bit(total(v, ["A", "B", "C"]) === 1) })) },
  {
    group: "unseen",
    name: "3-bit adder",
    request: "An adder for two 3-bit numbers: inputs A2 A1 A0 and B2 B1 B0, outputs S3 S2 S1 S0.",
    check: behaves(["A2", "A1", "A0", "B2", "B1", "B0"], ["S3", "S2", "S1", "S0"], (v) => {
      const sum = v.A2! * 4 + v.A1! * 2 + v.A0! + v.B2! * 4 + v.B1! * 2 + v.B0!;
      return { S3: (sum >> 3) & 1, S2: (sum >> 2) & 1, S1: (sum >> 1) & 1, S0: sum & 1 };
    }),
  },
  { group: "unseen", name: "3-input NAND", request: "A NAND gate with three inputs A, B and C, output Y.", check: behaves(["A", "B", "C"], ["Y"], (v) => ({ Y: 1 - (v.A! & v.B! & v.C!) })) },
  { group: "unseen", name: "implication", request: "Inputs P and Q. Output IMPLIES is 0 only when P is 1 and Q is 0.", check: behaves(["P", "Q"], ["IMPLIES"], (v) => ({ IMPLIES: bit(!(v.P === 1 && v.Q === 0)) })) },
  {
    group: "unseen",
    name: "7-segment digit 0-3",
    request: "Inputs B1 and B0 form a number 0 to 3. Outputs SEG_A and SEG_B are 1 for the numbers 0, 2 and 3 (SEG_A) and for 0, 1, 2 and 3 (SEG_B).",
    check: behaves(["B1", "B0"], ["SEG_A", "SEG_B"], (v) => ({ SEG_A: bit([0, 2, 3].includes(v.B1! * 2 + v.B0!)), SEG_B: 1 })),
  },

  // --- change: the circuit in the editor, and what to do with it
  {
    group: "change",
    name: "half adder -> full adder",
    current: '.name "Half adder"\nA = INPUT\nB = INPUT\nsum = XOR(A, B)\ncarry = AND(A, B)\nS = OUTPUT(sum)\nC = OUTPUT(carry)\n',
    request: "Make it a full adder: add an input CIN for the carry in, and name the outputs SUM and COUT.",
    check: behaves(["A", "B", "CIN"], ["SUM", "COUT"], (v) => ({ SUM: v.A! ^ v.B! ^ v.CIN!, COUT: bit(total(v, ["A", "B", "CIN"]) >= 2) })),
  },
  {
    group: "change",
    name: "AND -> NAND",
    current: ".name \"And\"\nA = INPUT\nB = INPUT\nx = AND(A, B)\nY = OUTPUT(x)\n",
    request: "Invert the output.",
    check: behaves(["A", "B"], ["Y"], (v) => ({ Y: 1 - (v.A! & v.B!) })),
  },
  {
    group: "change",
    name: "add a third input",
    current: ".name \"And\"\nA = INPUT\nB = INPUT\nx = AND(A, B)\nY = OUTPUT(x)\n",
    request: "Add a third input C. Y should be 1 only when A, B and C are all 1.",
    check: behaves(["A", "B", "C"], ["Y"], (v) => ({ Y: v.A! & v.B! & v.C! })),
  },
  {
    group: "change",
    name: "OR -> NOR",
    current: ".name \"Expr\"\nA = INPUT\nB = INPUT\nC = INPUT\nab = AND(A, B)\ny = OR(ab, C)\nY = OUTPUT(y)\n",
    request: "Use a NOR instead of the OR.",
    check: behaves(["A", "B", "C"], ["Y"], (v) => ({ Y: 1 - ((v.A! & v.B!) | v.C!) })),
  },
  {
    group: "change",
    name: "add an enable",
    current: ".name \"Mux\"\nD0 = INPUT\nD1 = INPUT\nSEL = INPUT\nn = NOT(SEL)\na = AND(D0, n)\nb = AND(D1, SEL)\ny = OR(a, b)\nY = OUTPUT(y)\n",
    request: "Add an input EN. Y must be 0 unless EN is 1.",
    check: behaves(["D0", "D1", "SEL", "EN"], ["Y"], (v) => ({ Y: v.EN! & (v.SEL ? v.D1! : v.D0!) })),
  },
  {
    group: "change",
    name: "add an output",
    current: '.name "Half adder"\nA = INPUT\nB = INPUT\nsum = XOR(A, B)\ncarry = AND(A, B)\nS = OUTPUT(sum)\nC = OUTPUT(carry)\n',
    request: "Add an output NS that is the opposite of S.",
    check: behaves(["A", "B"], ["S", "C", "NS"], (v) => ({ S: v.A! ^ v.B!, C: v.A! & v.B!, NS: 1 - (v.A! ^ v.B!) })),
  },
];

/** What a circuit computes, as formulas, for the log. */
function formulasOf(circuit: Circuit): string {
  const described = describeCircuit(circuit);
  if (!described.ok) return "";
  const { signals, outputs } = described.spec;
  return [...signals, ...outputs].map((definition) => `${definition.name} = ${definition.formula}`).join("; ");
}

async function main(): Promise<void> {
  const baseUrl = process.env["OLLAMA_URL"] ?? "http://127.0.0.1:11434";
  const installed = await listModels(baseUrl);
  const name = process.argv[2] ?? installed[0]?.name;
  if (name === undefined) throw new AssistantError("model-not-found", "No model is installed in Ollama.");
  const info = installed.find((model) => model.name === name);
  const model = new OllamaClient({ model: name, baseUrl, seed: 7 });
  console.log(`Model ${name}${info?.parameterSize === undefined ? "" : ` (${info.parameterSize} parameters)`}, temperature 0.2, seed 7, up to 3 attempts per request.\n`);

  const results: { group: Group; valid: boolean; correct: boolean; firstTry: boolean; seconds: number }[] = [];
  for (const task of TASKS) {
    const started = performance.now();
    let current: Circuit | undefined;
    if (task.current !== undefined) current = parseNetlist(task.current);
    const design = await designCircuit(model, { request: task.request, ...(current !== undefined && { current }) });
    const seconds = (performance.now() - started) / 1000;
    let verdict: string;
    let correct = false;
    if (design.ok) {
      const wrong = task.check(design.circuit);
      correct = wrong === undefined;
      verdict = correct ? "RIGHT" : `valid, but WRONG: ${wrong}
${' '.repeat(46)}${formulasOf(design.circuit)}`;
    } else {
      verdict = design.reason === "declined" ? `declined: ${design.message}` : `GAVE UP: ${design.problems[0]}`;
    }
    console.log(`${task.group.padEnd(8)} ${task.name.padEnd(26)} ${String(design.attempts)} attempt${design.attempts === 1 ? " " : "s"} ${seconds.toFixed(1).padStart(5)} s  ${verdict}`);
    results.push({ group: task.group, valid: design.ok, correct, firstTry: correct && design.attempts === 1, seconds });
  }

  console.log("\n| Requests | How many | Valid netlist | Right | Right on the first try |\n| --- | ---: | ---: | ---: | ---: |");
  for (const group of ["cookbook", "unseen", "change"] as const) {
    const rows = results.filter((result) => result.group === group);
    const count = (predicate: (result: (typeof rows)[number]) => boolean): number => rows.filter(predicate).length;
    console.log(`| ${group} | ${rows.length} | ${count((r) => r.valid)} | ${count((r) => r.correct)} | ${count((r) => r.firstTry)} |`);
  }
  const all = results.length;
  console.log(`| **all** | ${all} | ${results.filter((r) => r.valid).length} | ${results.filter((r) => r.correct).length} | ${results.filter((r) => r.firstTry).length} |`);
  const seconds = results.map((r) => r.seconds).sort((a, b) => a - b);
  console.log(`\nTime per request: median ${(seconds[Math.floor(all / 2)] ?? 0).toFixed(1)} s, slowest ${(seconds[all - 1] ?? 0).toFixed(1)} s.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof AssistantError ? `\n${error.message}` : error);
  process.exitCode = 1;
});
