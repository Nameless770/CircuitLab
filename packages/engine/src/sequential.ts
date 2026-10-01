import { stronglyConnectedComponents } from "./components";
import { OscillationError } from "./errors";
import { evaluateNode } from "./gate-factory";
import { checkArguments, type SimulationInputs, type SimulationState } from "./inputs";
import { at } from "./internal/util";
import { buildNetwork, type GateNetwork } from "./network";
import type { PreparedCircuit, SequentialResult } from "./results";
import type { Bit } from "./types";
import { assertValidCircuit } from "./validate";

export interface SequentialOptions {
  /**
   * How many evaluations a loop gets, per gate on it, to settle before it is declared oscillating.
   * Default 100: real loops (latches, flip-flops) settle within a few rounds.
   */
  readonly maxEvaluationsPerGate?: number;
}

/** A step of the evaluation: one gate outside any loop, or one feedback loop. */
interface Part {
  readonly slots: readonly number[];
  readonly loop: boolean;
}

/**
 * A circuit prepared for sequential simulation: circuits with feedback loops (latches,
 * flip-flops, oscillators) are simulated step by step, and remember their state in between.
 *
 * How a step works:
 * 1. The circuit is split into its strongly connected components, in dependency order. A
 *    component with more than one gate, or a gate wired to itself, is a feedback loop; the other
 *    components are single gates.
 * 2. Each single gate is evaluated once, after everything that drives it: exactly what
 *    combinational simulation does. So a circuit without loops gives the same answer either way.
 * 3. Each loop starts from its state (the values its gates had at the end of the previous step,
 *    0 at first) and is evaluated repeatedly, one gate at a time in declaration order, each gate
 *    re-queued when one of its inputs changes, until nothing changes: the loop has settled.
 *    A loop that keeps changing, such as a ring of three inverters, throws OscillationError.
 *
 * The evaluation order is fixed, so results are reproducible. Where real hardware would race (an
 * SR latch released from S = R = 1 at once), the result is one of the possible outcomes, chosen by
 * declaration order.
 */
export class SequentialCircuit implements PreparedCircuit {
  readonly mode = "sequential";
  readonly name: string | undefined;
  readonly gateIds: readonly string[];
  readonly inputIds: readonly string[];
  readonly outputIds: readonly string[];
  /** The gates on feedback loops, in declaration order: the circuit's memory. */
  readonly stateIds: readonly string[];

  private readonly network: GateNetwork;
  private readonly parts: readonly Part[];
  private readonly maxEvaluationsPerGate: number;

  /** @throws CircuitValidationError listing every problem with the circuit */
  constructor(circuit: unknown, options: SequentialOptions = {}) {
    assertValidCircuit(circuit);
    this.network = buildNetwork(circuit); // every gate made by the gate factory
    this.maxEvaluationsPerGate = options.maxEvaluationsPerGate ?? 100;
    this.parts = stronglyConnectedComponents(this.network.fanout).map((slots) => ({
      slots,
      loop: slots.length > 1 || at(this.network.fanout, at(slots, 0)).includes(at(slots, 0)),
    }));
    this.name = this.network.name;
    this.gateIds = this.network.gateIds;
    this.inputIds = this.network.inputIds;
    this.outputIds = this.network.outputIds;
    const inLoops = this.parts.filter((part) => part.loop).flatMap((part) => part.slots);
    this.stateIds = Object.freeze([...inLoops].sort((a, b) => a - b).map((slot) => at(this.gateIds, slot)));
  }

  /**
   * One step: apply the inputs, let every loop settle, report the outputs and the new state.
   *
   * @param state what the loops remembered from the previous step (a missing gate starts at 0)
   * @throws SimulationInputError listing every problem with `inputs` and `state`
   * @throws OscillationError if a loop doesn't settle
   */
  run(inputs: SimulationInputs, state?: SimulationState): SequentialResult {
    const { inputValues, stateValues } = checkArguments(this.inputIds, this.stateIds, inputs, state);
    const { nodes, fanout, gateIds } = this.network;
    const signals: Bit[] = gateIds.map((id) => stateValues.get(id) ?? 0);
    const read = (slot: number): Bit => at(signals, slot);
    let evaluations = 0;

    for (const part of this.parts) {
      if (!part.loop) {
        const slot = at(part.slots, 0);
        signals[slot] = evaluateNode(at(nodes, slot), inputValues, read);
        evaluations++;
        continue;
      }
      // A feedback loop: evaluate its gates until none of them changes.
      const members = new Set(part.slots);
      const queue = [...part.slots];
      const queued = new Set(part.slots);
      const budget = this.maxEvaluationsPerGate * part.slots.length;
      for (let head = 0, spent = 0; head < queue.length; head++) {
        if (++spent > budget) throw new OscillationError(part.slots.map((slot) => at(gateIds, slot)));
        const slot = at(queue, head);
        queued.delete(slot);
        const value = evaluateNode(at(nodes, slot), inputValues, read);
        evaluations++;
        if (value === signals[slot]) continue;
        signals[slot] = value;
        for (const next of at(fanout, slot)) {
          if (members.has(next) && !queued.has(next)) {
            queue.push(next);
            queued.add(next);
          }
        }
      }
    }

    return {
      mode: "sequential",
      outputs: Object.fromEntries(this.network.outputSlots.map((slot) => [at(gateIds, slot), at(signals, slot)])),
      signals: Object.fromEntries(gateIds.map((id, slot) => [id, at(signals, slot)])),
      state: Object.fromEntries(this.stateIds.map((id) => [id, at(signals, gateIds.indexOf(id))])),
      evaluations,
    };
  }
}
