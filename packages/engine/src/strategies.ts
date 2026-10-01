import { CompiledCircuit } from "./compile";
import { SIMULATION_MODES, type PreparedCircuit, type SimulationMode } from "./results";
import { SequentialCircuit, type SequentialOptions } from "./sequential";

/**
 * One way of simulating a circuit (the strategy pattern). Callers pick a strategy by mode and use
 * every strategy the same way, prepare once, then run any number of times, without knowing how
 * it works inside:
 *
 *   const prepared = simulationStrategy(mode).prepare(circuitJson);
 *   const step1 = prepared.run({ S: 1, R: 0 });
 *   const step2 = prepared.run({ S: 0, R: 0 }, step1.mode === "sequential" ? step1.state : undefined);
 *
 * The worker threads, the API, and the demos all go through this registry, so a new mode means
 * a new strategy here, not changes to each of them.
 */
export interface SimulationStrategy {
  readonly mode: SimulationMode;
  /** One sentence for people. */
  readonly description: string;
  /**
   * Validates the circuit and prepares it: the work done once, however many runs follow.
   *
   * @throws CircuitValidationError for an invalid circuit; CycleError if this mode can't handle feedback loops
   */
  prepare(circuit: unknown): PreparedCircuit;
}

/** Every gate once, in dependency order. Fast, and enough for any circuit without feedback loops. */
export const combinational: SimulationStrategy = {
  mode: "combinational",
  description: "Every gate once, in dependency order. Refuses circuits with feedback loops (CycleError).",
  prepare: (circuit) => new CompiledCircuit(circuit),
};

/**
 * A sequential strategy with its settings: tests use a small budget to find oscillation quickly.
 * (Its settings are injected, not hard-wired: dependency injection, in function form.)
 */
export function sequentialStrategy(options: SequentialOptions = {}): SimulationStrategy {
  return {
    mode: "sequential",
    description: "Loops are evaluated until they settle, starting from the state of the previous step. Runs latches and flip-flops.",
    prepare: (circuit) => new SequentialCircuit(circuit, options),
  };
}

export const sequential: SimulationStrategy = sequentialStrategy();

const STRATEGIES: Readonly<Record<SimulationMode, SimulationStrategy>> = { combinational, sequential };

/** The strategy for a mode. @throws RangeError for a mode that doesn't exist */
export function simulationStrategy(mode: SimulationMode): SimulationStrategy {
  const strategy = (STRATEGIES as Readonly<Record<string, SimulationStrategy | undefined>>)[mode];
  if (strategy === undefined) throw new RangeError(`Unknown simulation mode ${JSON.stringify(mode)} (modes: ${SIMULATION_MODES.join(", ")})`);
  return strategy;
}
