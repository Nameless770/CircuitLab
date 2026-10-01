import { CompiledCircuit, compileCircuit, type Step } from "./compile";
import { SimulationInputError, type InputIssue } from "./errors";
import { at, isRecord, quote, showValue } from "./internal/util";
import type { Bit, Circuit } from "./types";

/** One value per INPUT gate, keyed by gate id. */
export type SimulationInputs = Readonly<Record<string, Bit>>;

export interface SimulationResult {
  /** The value shown by each OUTPUT gate, keyed by gate id. */
  readonly outputs: Readonly<Record<string, Bit>>;
  /** The output signal of every gate, keyed by gate id (for an OUTPUT gate: the value it shows). */
  readonly signals: Readonly<Record<string, Bit>>;
  /** Gate ids in the order they were evaluated. */
  readonly order: readonly string[];
}

/**
 * Evaluates the circuit once for the given inputs.
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
  const read = runPlan(compiled, readInputs(compiled, inputs));

  // Object.fromEntries defines real own properties, so even a gate id like "__proto__"
  // becomes an ordinary key instead of touching the object's prototype.
  return {
    outputs: Object.fromEntries(compiled.outputSlots.map((slot) => [at(compiled.gateIds, slot), read(slot)])),
    signals: Object.fromEntries(compiled.gateIds.map((id, slot) => [id, read(slot)])),
    order: compiled.order,
  };
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
  const evaluate = (step: Step): Bit => {
    switch (step.kind) {
      case "input":
        return at(inputValues, step.input);
      case "const":
        return step.value;
      case "logic":
        return step.evaluate(step.sources.map(read));
    }
  };

  for (const step of compiled.steps) {
    signals[step.slot] = evaluate(step);
  }
  return read;
}

/** Checks `inputs` against the circuit, reporting every problem. Returns values in `inputIds` order. */
function readInputs(compiled: CompiledCircuit, inputs: unknown): Bit[] {
  if (!isRecord(inputs)) {
    throw new SimulationInputError([
      {
        code: "MALFORMED_INPUTS",
        message: `Inputs must be an object mapping INPUT gate ids to 0 or 1, got ${showValue(inputs)}`,
      },
    ]);
  }

  const issues: InputIssue[] = [];
  const values: Bit[] = [];

  for (const id of compiled.inputIds) {
    if (!Object.hasOwn(inputs, id)) {
      issues.push({ code: "MISSING_INPUT", message: `No value given for input ${quote(id)}`, inputId: id });
      continue;
    }
    const value = inputs[id];
    if (value === 0 || value === 1) {
      values.push(value);
    } else {
      issues.push({ code: "INVALID_INPUT_VALUE", message: `Input ${quote(id)} must be 0 or 1, got ${showValue(value)}`, inputId: id });
    }
  }

  for (const name of Object.keys(inputs)) {
    if (compiled.inputIds.includes(name)) continue;
    const expected = compiled.inputIds.length > 0 ? compiled.inputIds.map(quote).join(", ") : "none";
    issues.push({
      code: "UNKNOWN_INPUT",
      message: `${quote(name)} is not an input of this circuit (inputs: ${expected})`,
      inputId: name,
    });
  }

  if (issues.length > 0) throw new SimulationInputError(issues);
  return values;
}
