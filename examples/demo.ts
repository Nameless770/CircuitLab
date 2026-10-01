/**
 * CircuitLab engine demo: truth tables for two adders, then what each kind of error looks like.
 *
 *   npm run demo        (from the repository root)
 *
 * The engine is imported by package name, exactly as the NestJS API will import it later.
 */
import {
  CircuitLabError,
  CycleError,
  compileCircuit,
  simulate,
  truthTable,
  validateCircuit,
  type Bit,
  type Circuit,
  type SimulationInputs,
  type TruthTableRow,
  type Wire,
} from "@circuitlab/engine";

const wire = (from: string, to: string, toPin = 0): Wire => ({ from, to, toPin });

// ---------------------------------------------------------------------------------------------
// Circuits
// ---------------------------------------------------------------------------------------------

/** Adds two bits: S = A XOR B, C = A AND B. */
const halfAdder: Circuit = {
  name: "Half adder",
  gates: [
    { id: "A", type: "INPUT" },
    { id: "B", type: "INPUT" },
    { id: "xor", type: "XOR" },
    { id: "and", type: "AND" },
    { id: "S", type: "OUTPUT", label: "Sum" },
    { id: "C", type: "OUTPUT", label: "Carry" },
  ],
  wires: [
    wire("A", "xor", 0), wire("B", "xor", 1),
    wire("A", "and", 0), wire("B", "and", 1),
    wire("xor", "S"), wire("and", "C"),
  ],
};

/**
 * Adds three bits.
 *   Sum  is 1 when an odd number of inputs are 1: a single 3-input XOR (odd parity).
 *   Cout is 1 when at least two inputs are 1: the OR of the three pairwise ANDs (majority).
 */
const fullAdder: Circuit = {
  name: "Full adder",
  gates: [
    { id: "A", type: "INPUT" },
    { id: "B", type: "INPUT" },
    { id: "Cin", type: "INPUT", label: "Carry in" },
    { id: "parity", type: "XOR" },
    { id: "ab", type: "AND" },
    { id: "ac", type: "AND" },
    { id: "bc", type: "AND" },
    { id: "majority", type: "OR" },
    { id: "S", type: "OUTPUT", label: "Sum" },
    { id: "Cout", type: "OUTPUT", label: "Carry out" },
  ],
  wires: [
    wire("A", "parity", 0), wire("B", "parity", 1), wire("Cin", "parity", 2),
    wire("A", "ab", 0), wire("B", "ab", 1),
    wire("A", "ac", 0), wire("Cin", "ac", 1),
    wire("B", "bc", 0), wire("Cin", "bc", 1),
    wire("ab", "majority", 0), wire("ac", "majority", 1), wire("bc", "majority", 2),
    wire("parity", "S"), wire("majority", "Cout"),
  ],
};

/**
 * SR latch: two cross-coupled NOR gates, each feeding the other. That feedback is what lets
 * a latch remember a bit, and also why it has no evaluation order in a combinational engine.
 */
const srLatch: Circuit = {
  name: "SR latch",
  gates: [
    { id: "S", type: "INPUT" },
    { id: "R", type: "INPUT" },
    { id: "q", type: "NOR" },
    { id: "qbar", type: "NOR" },
    { id: "out_q", type: "OUTPUT" },
    { id: "out_qbar", type: "OUTPUT" },
  ],
  wires: [
    wire("R", "q", 0), wire("qbar", "q", 1),
    wire("S", "qbar", 0), wire("q", "qbar", 1),
    wire("q", "out_q"), wire("qbar", "out_qbar"),
  ],
};

/** One of (almost) every structural mistake, typed `unknown` as if just parsed from a request body. */
const brokenCircuit: unknown = {
  name: "Broken on purpose",
  gates: [
    { id: "A", type: "INPUT" },
    { id: "B", type: "INPUT" },
    { id: "A", type: "INPUT" }, //                   duplicate gate id
    { id: "one", type: "CONST", value: 2 }, //       CONST value must be 0 or 1
    { id: "maj", type: "MAJORITY" }, //              unknown gate type
    { type: "AND" }, //                              missing id
    { id: "inv", type: "NOT" },
    { id: "both", type: "AND" },
    { id: "Y", type: "OUTPUT" },
    { id: "Z", type: "OUTPUT" },
  ],
  wires: [
    { id: "w1", from: "A", to: "inv", toPin: 0 },
    { from: "B", to: "inv", toPin: 0 }, //           pin 0 of "inv" is already driven
    { from: "A", to: "inv", toPin: 1 }, //           NOT only has pin 0
    { id: "w1", from: "A", to: "both", toPin: 0 }, // duplicate wire id
    { from: "ghost", to: "Y", toPin: 0 }, //         no gate called "ghost"
    { from: "Y", to: "Z", toPin: 0 }, //             OUTPUT gates can't drive anything
    { from: "inv", to: "nowhere", toPin: 0 }, //     no gate called "nowhere"
    { from: "B", to: "both", toPin: "1" }, //        toPin must be a number, so pin 1 of "both" stays unconnected
  ],
};

// ---------------------------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------------------------

function section(title: string): void {
  console.log(`\n=== ${title} ${"=".repeat(Math.max(3, 72 - title.length))}\n`);
}

function print(text: string): void {
  console.log(text.replace(/^(?=.)/gm, "  "));
}

/** Runs `action`, which must throw one of the engine's errors, and returns that error. */
function expectEngineError(action: () => unknown): CircuitLabError {
  try {
    action();
  } catch (error) {
    // One base class catches every error the engine throws on purpose.
    if (error instanceof CircuitLabError) return error;
    throw error;
  }
  throw new Error("Expected the engine to throw, but it did not");
}

/**
 * An adder's outputs, [sum, carry], must spell out in binary how many of its inputs are 1.
 * Both adders below declare their outputs in that order.
 */
function addsUp(row: TruthTableRow): boolean {
  const ones = row.inputs.reduce<number>((total, value) => total + value, 0);
  const [sum, carry] = row.outputs;
  return sum === (ones & 1) && carry === ones >> 1;
}

/**
 * Prints every input combination with its outputs and checks each row. `truthTable` compiles
 * the circuit once, then only evaluates the compiled plan for each row.
 */
function printTruthTable(circuit: Circuit, check: (row: TruthTableRow) => boolean, rule: string): void {
  const compiled = compileCircuit(circuit);
  const { inputIds, outputIds, rows } = truthTable(compiled);
  const cells = (ids: readonly string[], values?: readonly Bit[]): string =>
    ids.map((id, k) => (values ? String(values[k]) : id).padStart(id.length)).join(" ");

  section(`${compiled.name} truth table`);
  print(`evaluation order: ${compiled.order.join(" -> ")}\n`);

  const header = `${cells(inputIds)} | ${cells(outputIds)}`;
  print(header);
  print(header.replace(/[^|]/g, "-").replace("|", "+"));

  let allRowsMatch = true;
  for (const row of rows) {
    const rowMatches = check(row);
    allRowsMatch &&= rowMatches;
    print(`${cells(inputIds, row.inputs)} | ${cells(outputIds, row.outputs)}${rowMatches ? "" : "   <-- WRONG"}`);
  }
  print(`\n${allRowsMatch ? "OK" : "FAILED"}: every row satisfies ${rule}`);
}

// ---------------------------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------------------------

printTruthTable(halfAdder, addsUp, "A + B = 2*C + S");
printTruthTable(fullAdder, addsUp, "A + B + Cin = 2*Cout + S");

section("One full simulation result (full adder, A=1 B=1 Cin=0)");
const result = simulate(compileCircuit(fullAdder), { A: 1, B: 1, Cin: 0 });
print(`outputs: ${JSON.stringify(result.outputs)}`);
print(`signals: ${JSON.stringify(result.signals)}`);
print(`order:   ${JSON.stringify(result.order)}`);

section("SR latch: a feedback loop");
print(`validateCircuit(srLatch) finds ${validateCircuit(srLatch).length} issues: each gate and wire is fine on its own.`);
print("The loop is a property of the whole graph, so it is caught while sorting:\n");
const cycleError = expectEngineError(() => compileCircuit(srLatch));
print(`${cycleError.name}: ${cycleError.message}`);
if (cycleError instanceof CycleError) print(`error.cycle = ${JSON.stringify(cycleError.cycle)}`);

section("A deliberately broken circuit");
const issues = validateCircuit(brokenCircuit);
print(`validateCircuit(broken) returns all ${issues.length} issues at once; compileCircuit throws them together:\n`);
const validationError = expectEngineError(() => compileCircuit(brokenCircuit));
print(`${validationError.name}: ${validationError.message}`);
print("\nEach issue is structured data, ready to send back from an API:");
print(JSON.stringify(issues.find((issue) => issue.code === "MULTIPLE_DRIVERS")));

section("Bad simulation inputs (half adder)");
// Typical client mistakes: "1" as a string (e.g. from a query string), a forgotten input, and
// an input that belongs to a different circuit. JSON.parse returns `any`, like a request body.
const badInputs: SimulationInputs = JSON.parse('{ "A": "1", "Cin": 0 }');
const inputError = expectEngineError(() => simulate(compileCircuit(halfAdder), badInputs));
print(`${inputError.name}: ${inputError.message}`);
console.log();
