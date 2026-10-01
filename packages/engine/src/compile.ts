import { evaluateNode, type GateNode } from "./gate-factory";
import { checkArguments, type SimulationInputs, type SimulationState } from "./inputs";
import { at } from "./internal/util";
import { buildNetwork } from "./network";
import type { CombinationalResult, PreparedCircuit } from "./results";
import { topologicalSort } from "./topological-sort";
import type { Bit } from "./types";
import { assertValidCircuit } from "./validate";

/** One gate's work during a combinational simulation, as made by the gate factory. */
export type Step = GateNode;

/**
 * A circuit validated and sorted once, ready to simulate combinationally any number of times: the
 * combinational strategy's prepared circuit (see strategies.ts).
 *
 * The constructor is the only place validation and sorting happen, so any `CompiledCircuit`
 * value is known to describe a valid, loop-free circuit. It keeps its own copy of everything
 * it needs, so later changes to the source object don't affect it.
 */
export class CompiledCircuit implements PreparedCircuit {
  readonly mode = "combinational";
  readonly name: string | undefined;
  /** All gate ids, in declaration order. */
  readonly gateIds: readonly string[];
  /** INPUT gate ids in declaration order: exactly the keys `simulate` expects. */
  readonly inputIds: readonly string[];
  /** OUTPUT gate ids in declaration order. */
  readonly outputIds: readonly string[];
  /** Gate ids in evaluation order. */
  readonly order: readonly string[];
  /** A circuit without loops remembers nothing between simulations. */
  readonly stateIds: readonly string[] = Object.freeze([]);

  /** @internal Evaluation plan: one step per gate, in `order`. */
  readonly steps: readonly Step[];
  /** @internal Slots of the OUTPUT gates, in declaration order. */
  readonly outputSlots: readonly number[];

  /** Prefer `compileCircuit`, which does the same thing. */
  constructor(circuit: unknown) {
    assertValidCircuit(circuit); // throws CircuitValidationError listing every issue
    const order = topologicalSort(circuit); // throws CycleError on a feedback loop
    const network = buildNetwork(circuit); // every gate made by the gate factory
    const slotById = new Map(network.gateIds.map((id, slot) => [id, slot]));

    this.name = network.name;
    this.gateIds = network.gateIds;
    this.inputIds = network.inputIds;
    this.outputIds = network.outputIds;
    this.outputSlots = network.outputSlots;
    this.order = Object.freeze(order);
    this.steps = Object.freeze(order.map((id) => at(network.nodes, slotById.get(id) ?? -1)));
  }

  /**
   * One evaluation: every gate once, in dependency order. A combinational circuit has no state,
   * so `state` may only be empty.
   *
   * @throws SimulationInputError listing every problem with `inputs` and `state`
   */
  run(inputs: SimulationInputs, state?: SimulationState): CombinationalResult {
    const { inputValues } = checkArguments(this.inputIds, this.stateIds, inputs, state);
    const read = runPlan(this, inputValues);
    // Object.fromEntries defines real own properties, so even a gate id like "__proto__"
    // becomes an ordinary key instead of touching the object's prototype.
    return {
      mode: "combinational",
      outputs: Object.fromEntries(this.outputSlots.map((slot) => [at(this.gateIds, slot), read(slot)])),
      signals: Object.fromEntries(this.gateIds.map((id, slot) => [id, read(slot)])),
      order: this.order,
    };
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

/**
 * @internal Runs every step of the plan for already-checked input values (in `inputIds` order)
 * and returns a reader for the resulting signal of any gate slot.
 */
export function runPlan(compiled: CompiledCircuit, inputValues: readonly Bit[]): (slot: number) => Bit {
  // One entry per gate. Steps run in topological order, so every read finds a value that
  // has already been computed. Reading `undefined` would mean the ordering is broken.
  const signals: (Bit | undefined)[] = new Array(compiled.gateIds.length);
  const read = (slot: number): Bit => {
    const value = signals[slot];
    if (value === undefined) throw new Error(`Internal error: gate "${at(compiled.gateIds, slot)}" read before it was evaluated`);
    return value;
  };
  for (const step of compiled.steps) signals[step.slot] = evaluateNode(step, inputValues, read);
  return read;
}
