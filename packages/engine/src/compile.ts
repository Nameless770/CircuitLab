import { GATE_LOGIC, type Evaluator } from "./gates";
import { at } from "./internal/util";
import { topologicalSort } from "./topological-sort";
import type { Bit } from "./types";
import { assertValidCircuit } from "./validate";

/**
 * One gate's work during a simulation. `slot` is the gate's declaration index and its position
 * in the signal array; `sources` are the slots of the gates driving it, ordered by input pin.
 */
export type Step =
  | { readonly kind: "input"; readonly slot: number; readonly input: number } // index into `inputIds`
  | { readonly kind: "const"; readonly slot: number; readonly value: Bit }
  | { readonly kind: "logic"; readonly slot: number; readonly evaluate: Evaluator; readonly sources: readonly number[] };

/**
 * A circuit that has been validated and sorted once, ready to simulate any number of times.
 *
 * The constructor is the only place validation and sorting happen, so any `CompiledCircuit`
 * value is known to describe a valid, loop-free circuit. It keeps its own copy of everything
 * it needs, so later changes to the source object don't affect it.
 */
export class CompiledCircuit {
  readonly name: string | undefined;
  /** All gate ids, in declaration order. */
  readonly gateIds: readonly string[];
  /** INPUT gate ids in declaration order: exactly the keys `simulate` expects. */
  readonly inputIds: readonly string[];
  /** OUTPUT gate ids in declaration order. */
  readonly outputIds: readonly string[];
  /** Gate ids in evaluation order. */
  readonly order: readonly string[];

  /** @internal Evaluation plan: one step per gate, in `order`. */
  readonly steps: readonly Step[];
  /** @internal Slots of the OUTPUT gates, in declaration order. */
  readonly outputSlots: readonly number[];

  /** Prefer `compileCircuit`, which does the same thing. */
  constructor(circuit: unknown) {
    assertValidCircuit(circuit); // throws CircuitValidationError listing every issue
    const order = topologicalSort(circuit); // throws CycleError on a feedback loop
    const { gates, wires } = circuit;

    const slotById = new Map(gates.map((gate, slot) => [gate.id, slot]));
    const slotOf = (id: string): number => {
      const slot = slotById.get(id);
      if (slot === undefined) throw new Error(`Internal error: no slot for gate "${id}"`);
      return slot;
    };

    // Validation guarantees one wire per used pin and no gaps, so these arrays end up dense.
    const sources: number[][] = gates.map(() => []);
    for (const wire of wires) at(sources, slotOf(wire.to))[wire.toPin] = slotOf(wire.from);

    const inputIds = gates.filter((gate) => gate.type === "INPUT").map((gate) => gate.id);
    const outputSlots = gates.flatMap((gate, slot) => (gate.type === "OUTPUT" ? [slot] : []));

    this.name = circuit.name;
    this.gateIds = Object.freeze(gates.map((gate) => gate.id));
    this.inputIds = Object.freeze(inputIds);
    this.outputIds = Object.freeze(outputSlots.map((slot) => at(gates, slot).id));
    this.order = Object.freeze(order);
    this.outputSlots = Object.freeze(outputSlots);
    this.steps = Object.freeze(
      order.map((id): Step => {
        const slot = slotOf(id);
        const gate = at(gates, slot);
        switch (gate.type) {
          case "INPUT":
            return { kind: "input", slot, input: inputIds.indexOf(id) };
          case "CONST":
            return { kind: "const", slot, value: gate.value };
          case "OUTPUT": // an OUTPUT just shows its input, exactly like a buffer
            return { kind: "logic", slot, evaluate: GATE_LOGIC.BUF, sources: at(sources, slot) };
          default:
            return { kind: "logic", slot, evaluate: GATE_LOGIC[gate.type], sources: at(sources, slot) };
        }
      }),
    );
  }
}

/**
 * Validates and sorts a circuit once, returning a reusable plan for `simulate`.
 * Accepts untrusted input such as parsed JSON.
 *
 * @throws CircuitValidationError listing every problem found
 * @throws CycleError if the gates form a feedback loop
 */
export function compileCircuit(circuit: unknown): CompiledCircuit {
  return new CompiledCircuit(circuit);
}
