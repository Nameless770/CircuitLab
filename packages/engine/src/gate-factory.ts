import { GATE_DEFINITIONS, type Evaluator } from "./gates";
import type { Bit, Gate } from "./types";

/**
 * A gate ready to run: what the simulation strategies evaluate. `slot` is the gate's declaration
 * index, which is also its place in the array of signals.
 */
export type GateNode =
  /** `input` is the gate's position among the circuit's INPUT gates. */
  | { readonly kind: "input"; readonly slot: number; readonly input: number }
  | { readonly kind: "const"; readonly slot: number; readonly value: Bit }
  /** `sources` are the slots of the gates driving its input pins, in pin order. */
  | { readonly kind: "logic"; readonly slot: number; readonly evaluate: Evaluator; readonly sources: readonly number[] };

/**
 * The gate factory: turns a gate described as data (JSON, a database row, a netlist line) into a
 * node that a simulation can run. It reads the gate registry (gates.ts) to decide how each type
 * behaves, so no simulation strategy needs a `switch` over gate types: every strategy builds its
 * gates here, and a new gate type needs a registry entry, not changes to the strategies.
 *
 * @param slot the gate's declaration index
 * @param sources slots of the gates driving each input pin, in pin order
 * @param inputIndex the gate's position among the circuit's INPUT gates (INPUT gates only)
 */
export function createGateNode(gate: Gate, slot: number, sources: readonly number[], inputIndex: number): GateNode {
  const { behaviour } = GATE_DEFINITIONS[gate.type];
  switch (behaviour.kind) {
    case "input":
      return { kind: "input", slot, input: inputIndex };
    case "const":
      if (gate.type !== "CONST") throw new Error(`Internal error: the registry gives ${gate.type} a constant value`);
      return { kind: "const", slot, value: gate.value };
    case "logic":
      return { kind: "logic", slot, evaluate: behaviour.evaluate, sources };
  }
}

/** Evaluates a node, given its input values (for INPUT gates) and a reader for other gates' signals. */
export function evaluateNode(node: GateNode, inputValues: readonly Bit[], read: (slot: number) => Bit): Bit {
  switch (node.kind) {
    case "input": {
      const value = inputValues[node.input];
      if (value === undefined) throw new Error(`Internal error: no value for input #${node.input}`);
      return value;
    }
    case "const":
      return node.value;
    case "logic":
      return node.evaluate(node.sources.map(read));
  }
}
