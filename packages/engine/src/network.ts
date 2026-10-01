import { createGateNode, type GateNode } from "./gate-factory";
import { at } from "./internal/util";
import type { Circuit } from "./types";

/**
 * A valid circuit as a graph of runnable gates: what every simulation strategy starts from. It
 * doesn't order the gates, so circuits with feedback loops have one too.
 */
export interface GateNetwork {
  readonly name: string | undefined;
  /** All gate ids, in declaration order; a gate's slot is its index here. */
  readonly gateIds: readonly string[];
  /** INPUT gate ids in declaration order: exactly the keys a simulation expects. */
  readonly inputIds: readonly string[];
  /** OUTPUT gate ids in declaration order. */
  readonly outputIds: readonly string[];
  readonly outputSlots: readonly number[];
  /** One node per gate, by slot, made by the gate factory. */
  readonly nodes: readonly GateNode[];
  /** For each slot, the slots of the gates it drives: in declaration order, each once. */
  readonly fanout: readonly (readonly number[])[];
}

/**
 * Builds the network of an already validated circuit (see `assertValidCircuit`). It keeps copies
 * of everything it needs, so later changes to `circuit` don't affect it.
 */
export function buildNetwork(circuit: Circuit): GateNetwork {
  const { gates, wires } = circuit;
  const slotById = new Map(gates.map((gate, slot) => [gate.id, slot]));
  const slotOf = (id: string): number => {
    const slot = slotById.get(id);
    if (slot === undefined) throw new Error(`Internal error: no slot for gate "${id}"`);
    return slot;
  };

  // Validation guarantees one wire per used pin and no gaps, so these arrays end up dense.
  const sources: number[][] = gates.map(() => []);
  const drives: Set<number>[] = gates.map(() => new Set());
  for (const wire of wires) {
    at(sources, slotOf(wire.to))[wire.toPin] = slotOf(wire.from);
    at(drives, slotOf(wire.from)).add(slotOf(wire.to));
  }

  const inputIds = gates.filter((gate) => gate.type === "INPUT").map((gate) => gate.id);
  const outputSlots = gates.flatMap((gate, slot) => (gate.type === "OUTPUT" ? [slot] : []));
  let inputIndex = 0;
  return {
    name: circuit.name,
    gateIds: Object.freeze(gates.map((gate) => gate.id)),
    inputIds: Object.freeze(inputIds),
    outputIds: Object.freeze(outputSlots.map((slot) => at(gates, slot).id)),
    outputSlots: Object.freeze(outputSlots),
    nodes: Object.freeze(gates.map((gate, slot) => createGateNode(gate, slot, Object.freeze(at(sources, slot)), gate.type === "INPUT" ? inputIndex++ : -1))),
    fanout: Object.freeze(drives.map((targets) => Object.freeze([...targets].sort((a, b) => a - b)))),
  };
}
