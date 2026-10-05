import { CycleError, OscillationError, compileCircuit, simulationStrategy, type Bit, type Circuit } from "@circuitlab/engine";

/**
 * Checks of a built circuit against what was asked, that don't need to know what the circuit
 * should compute. A circuit that passes can still be wrong (only the truth table shows that), but
 * these are mistakes a program can see for certain, and tell the model about in words.
 */

/** "Y0 to Y7", "D0-D3", "I0..I3": a run of numbered names, each of which the circuit must have. */
const RANGE = /\b([A-Za-z_]+)(\d+)\s*(?:to|through|thru|\.\.\.?|-|–)\s*\1(\d+)\b/gi;
/** The gates that can build any circuit, which exercises ask to build one from: "only NAND gates". */
const ONLY_GATE = /\b(?:only|just|solely|exclusively)\b(?:\s+(?:from|of|with|using|use))?\s+(?:the\s+)?(NAND|NOR)\b/i;

/** Names the request spells as a run, like Y0 to Y7: ["Y0", ..., "Y7"]. */
export function namesAskedFor(request: string): string[] {
  const names = new Set<string>();
  for (const match of request.matchAll(RANGE)) {
    const prefix = match[1] ?? "";
    const first = Number(match[2]);
    const last = Number(match[3]);
    if (first > last || last - first >= 64) continue;
    for (let number = first; number <= last; number++) names.add(`${prefix}${number}`);
  }
  return [...names];
}

/** "using only NAND gates": NAND. Undefined when the request doesn't say so. */
export function onlyGateAskedFor(request: string): "NAND" | "NOR" | undefined {
  const found = ONLY_GATE.exec(request)?.[1]?.toUpperCase();
  return found === "NAND" || found === "NOR" ? found : undefined;
}

/** Everything wrong with the circuit that a program can tell, each as a sentence. Empty when nothing is. */
export function requestProblems(request: string, circuit: Circuit): string[] {
  const problems: string[] = [];

  const named = new Set(circuit.gates.filter((gate) => gate.type === "INPUT" || gate.type === "OUTPUT").map((gate) => gate.id));
  const missing = namesAskedFor(request).filter((name) => !named.has(name));
  if (missing.length > 0) {
    const shown = missing.slice(0, 4).map((name) => `“${name}”`).join(", ");
    const more = missing.length > 4 ? ` and ${missing.length - 4} more` : "";
    problems.push(`The request names ${shown}${more}, but the circuit has no input or output ${missing.length === 1 ? "with that name" : "with those names"}. Use the names the request gives, every one of them.`);
  }

  const only = onlyGateAskedFor(request);
  if (only !== undefined) {
    const others = [...new Set(circuit.gates.map((gate) => gate.type).filter((type) => type !== "INPUT" && type !== "OUTPUT" && type !== "CONST" && type !== only))];
    if (others.length > 0) {
      problems.push(`The request says to use only ${only} gates, but the circuit also has ${others.join(" and ")} gates. Make every gate a ${only}: NOT(x) is ${only}(x, x), and so on.`);
    }
  }

  const unsettled = unsettledLoop(circuit);
  if (unsettled !== undefined) problems.push(unsettled);
  return problems;
}

/**
 * A circuit with a feedback loop is tried with some input values. A loop that never settles (a
 * gate that feeds only itself, say) is no latch, and a model that wrote one can be told so.
 */
function unsettledLoop(circuit: Circuit): string | undefined {
  try {
    compileCircuit(circuit);
    return undefined; // no loop: nothing to settle
  } catch (error) {
    if (!(error instanceof CycleError)) return undefined;
  }
  const inputs = circuit.gates.filter((gate) => gate.type === "INPUT").map((gate) => gate.id);
  const patterns: Record<string, Bit>[] = [];
  if (inputs.length <= 4) {
    for (let row = 0; row < 2 ** inputs.length; row++) patterns.push(Object.fromEntries(inputs.map((id, index) => [id, ((row >> (inputs.length - 1 - index)) & 1) as Bit])));
  } else {
    patterns.push(Object.fromEntries(inputs.map((id) => [id, 0 as Bit])), Object.fromEntries(inputs.map((id) => [id, 1 as Bit])));
    for (const high of inputs) patterns.push(Object.fromEntries(inputs.map((id) => [id, (id === high ? 1 : 0) as Bit])));
  }
  try {
    const run = simulationStrategy("sequential").prepare(circuit);
    for (const pattern of patterns) run.run(pattern);
  } catch (error) {
    if (error instanceof OscillationError) {
      return `The loop of gates ${error.gates.join(", ")} never settles: its values keep changing, for some input values. In a latch each gate must use the output of the other gate, as in q = NOR(R, qbar) and qbar = NOR(S, q).`;
    }
    // Anything else is not this check's business.
  }
  return undefined;
}
