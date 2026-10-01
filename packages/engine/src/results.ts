import type { SimulationInputs, SimulationState } from "./inputs";
import type { Bit } from "./types";

/** The two ways to simulate a circuit; see strategies.ts. */
export const SIMULATION_MODES = ["combinational", "sequential"] as const;
export type SimulationMode = (typeof SIMULATION_MODES)[number];

/** What `simulate` returns: one combinational evaluation. */
export interface SimulationResult {
  /** The value shown by each OUTPUT gate, keyed by gate id. */
  readonly outputs: Readonly<Record<string, Bit>>;
  /** The output signal of every gate, keyed by gate id (for an OUTPUT gate: the value it shows). */
  readonly signals: Readonly<Record<string, Bit>>;
  /** Gate ids in the order they were evaluated. */
  readonly order: readonly string[];
}

export interface CombinationalResult extends SimulationResult {
  readonly mode: "combinational";
}

export interface SequentialResult {
  readonly mode: "sequential";
  readonly outputs: Readonly<Record<string, Bit>>;
  readonly signals: Readonly<Record<string, Bit>>;
  /** The values of the gates on feedback loops once they settled: pass it to the next step. */
  readonly state: SimulationState;
  /** Gate evaluations it took, loops included: a measure of the work done. */
  readonly evaluations: number;
}

export type ModeResult = CombinationalResult | SequentialResult;

/** A circuit prepared by a simulation strategy, ready to simulate any number of times. */
export interface PreparedCircuit {
  readonly mode: SimulationMode;
  readonly name: string | undefined;
  readonly gateIds: readonly string[];
  readonly inputIds: readonly string[];
  readonly outputIds: readonly string[];
  /** The gates that hold state between steps: those on feedback loops. None in combinational mode. */
  readonly stateIds: readonly string[];
  /**
   * One evaluation for these inputs. `state` is what the circuit remembered from the step before
   * (sequential mode); without it, every gate starts at 0.
   *
   * @throws SimulationInputError listing every problem with `inputs` and `state`
   */
  run(inputs: SimulationInputs, state?: SimulationState): ModeResult;
}
