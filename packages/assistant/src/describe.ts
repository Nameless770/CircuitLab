import type { Circuit } from "@circuitlab/engine";
import type { CircuitSpec, Definition } from "./build";
import { RESERVED_WORDS } from "./formula";

/**
 * Writes an existing circuit as a spec: the same names and formulas the model writes, so that
 * "change this circuit" can show the model the circuit in its own words. Building the spec
 * again gives a circuit that behaves the same (checked in test/describe.test.ts); the gates may be
 * arranged differently, because only what they compute is kept.
 */

/** Bigger circuits are left alone: the model can't keep them in mind, and neither can a prompt. */
export const MAX_DESCRIBED_GATES = 80;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type Description = { readonly ok: true; readonly spec: CircuitSpec } | { readonly ok: false; readonly reason: string };

/** A formula written out, and whether it is a single name or number, which needs no parentheses. */
interface Written {
  readonly text: string;
  readonly atom: boolean;
}

export function describeCircuit(circuit: Circuit): Description {
  const logic = circuit.gates.filter((gate) => gate.type !== "INPUT" && gate.type !== "OUTPUT");
  if (circuit.gates.length > MAX_DESCRIBED_GATES) {
    return { ok: false, reason: `This circuit has ${circuit.gates.length} gates. The assistant can change circuits of up to ${MAX_DESCRIBED_GATES}; ask it for a new circuit instead.` };
  }

  const byId = new Map(circuit.gates.map((gate) => [gate.id, gate]));
  // The gates that feed each gate, in pin order, and how many gates read each gate.
  const sources = new Map<string, string[]>();
  const readers = new Map<string, number>();
  for (const wire of [...circuit.wires].sort((a, b) => a.toPin - b.toPin)) {
    sources.set(wire.to, [...(sources.get(wire.to) ?? []), wire.from]);
    readers.set(wire.from, (readers.get(wire.from) ?? 0) + 1);
  }

  // A gate is written out once, as a signal, when it is used more than once, or when it is part of
  // a loop (writing it in full wherever it's used would never end). Any other gate is written
  // inside the formula of the gate that uses it.
  const signals = new Set(logic.filter((gate) => gate.type !== "CONST" && (readers.get(gate.id) ?? 0) >= 2).map((gate) => gate.id));
  const visiting = new Set<string>();
  const finished = new Set<string>();
  const findLoops = (id: string): void => {
    if (finished.has(id)) return;
    if (visiting.has(id)) {
      signals.add(id);
      return;
    }
    const gate = byId.get(id);
    if (gate === undefined || gate.type === "INPUT" || gate.type === "CONST") return;
    visiting.add(id);
    for (const source of sources.get(id) ?? []) findLoops(source);
    visiting.delete(id);
    finished.add(id);
  };
  circuit.gates.forEach((gate) => findLoops(gate.id));

  const write = (id: string, own: boolean): Written => {
    const gate = byId.get(id);
    if (gate === undefined) return { text: "0", atom: true }; // can't happen in a circuit that was read; better than a crash
    if (gate.type === "INPUT") return { text: id, atom: true };
    if (gate.type === "CONST") return { text: String(gate.value), atom: true };
    if (signals.has(id) && !own) return { text: id, atom: true };
    const inputs = (sources.get(id) ?? []).map((source) => write(source, false));
    const wrapped = inputs.map((input) => (input.atom ? input.text : `(${input.text})`));
    const first = wrapped[0] ?? "";
    switch (gate.type) {
      case "BUF":
        return inputs[0] ?? { text: "0", atom: true };
      // ! binds tighter than anything, so the formulas that start with it need no parentheses.
      case "NOT":
        return { text: `!${first}`, atom: true };
      case "AND":
        return { text: wrapped.join(" & "), atom: false };
      case "OR":
        return { text: wrapped.join(" | "), atom: false };
      case "XOR":
        return { text: wrapped.join(" ^ "), atom: false };
      // These three have no operator of their own, so they are written as the gate function.
      case "NAND":
      case "NOR":
      case "XNOR":
        return { text: `${gate.type}(${inputs.map((input) => input.text).join(", ")})`, atom: true };
      default:
        return { text: first, atom: false }; // OUTPUT is never written inside another formula
    }
  };

  const inputs = circuit.gates.filter((gate) => gate.type === "INPUT").map((gate) => gate.id);
  const outputs: Definition[] = circuit.gates.filter((gate) => gate.type === "OUTPUT").map((gate) => ({ name: gate.id, formula: write(sources.get(gate.id)?.[0] ?? "", false).text }));
  const signalDefinitions: Definition[] = logic.filter((gate) => signals.has(gate.id)).map((gate) => ({ name: gate.id, formula: write(gate.id, true).text }));

  const named = [...inputs, ...outputs.map((output) => output.name), ...signalDefinitions.map((signal) => signal.name)];
  const unusable = named.find((name) => !NAME.test(name) || RESERVED_WORDS.includes(name.toLowerCase()));
  if (unusable !== undefined) {
    return { ok: false, reason: `The assistant can't change this circuit because of the name “${unusable}”: it only works with names that start with a letter and have only letters, digits and _. Rename it first, or ask for a new circuit.` };
  }
  return { ok: true, spec: { name: circuit.name ?? "Circuit", inputs, signals: signalDefinitions, outputs } };
}
