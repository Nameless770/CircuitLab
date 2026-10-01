import { CompiledCircuit, compileCircuit } from "./compile";
import type { SimulationInputs } from "./inputs";
import type { SimulationResult } from "./results";
import type { Circuit } from "./types";

/**
 * Evaluates the circuit once for the given inputs, combinationally: every gate once, in
 * dependency order. (For circuits with feedback loops, see the sequential strategy in
 * strategies.ts.)
 *
 * Pass a `CompiledCircuit` to run the same circuit many times cheaply. A plain `Circuit`
 * works too, but is validated and sorted again on every call.
 *
 * `inputs` is checked at runtime as well, since it may come from JSON.
 *
 * @throws SimulationInputError for missing inputs, unknown input names, or values other than 0 and 1
 * @throws CircuitValidationError or CycleError when given an invalid, uncompiled circuit
 */
export function simulate(circuit: Circuit | CompiledCircuit, inputs: SimulationInputs): SimulationResult {
  // `instanceof` can't be spoofed by JSON: a parsed object is never a CompiledCircuit,
  // so untrusted data always goes through validation.
  const compiled = circuit instanceof CompiledCircuit ? circuit : compileCircuit(circuit);
  const { outputs, signals, order } = compiled.run(inputs);
  return { outputs, signals, order };
}
