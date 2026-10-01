import { SimulationInputError, type InputIssue } from "./errors";
import { isRecord, quote, showValue } from "./internal/util";
import type { Bit } from "./types";

/** One value per INPUT gate, keyed by gate id. */
export type SimulationInputs = Readonly<Record<string, Bit>>;

/**
 * What a circuit remembers between sequential simulation steps: the values of the gates on its
 * feedback loops, keyed by gate id. Every other gate's value follows from the inputs and these.
 */
export type SimulationState = Readonly<Record<string, Bit>>;

/**
 * Checks a simulation's `inputs` and `state` against the circuit, which may both come from JSON,
 * reporting every problem at once.
 *
 * @param stateIds the gates that hold state (none, for a circuit without feedback loops)
 * @returns input values in `inputIds` order, and the state values given
 * @throws SimulationInputError listing every problem
 */
export function checkArguments(
  inputIds: readonly string[],
  stateIds: readonly string[],
  inputs: unknown,
  state: unknown,
): { readonly inputValues: Bit[]; readonly stateValues: ReadonlyMap<string, Bit> } {
  const issues: InputIssue[] = [];
  const inputValues = checkInputs(inputIds, inputs, issues);
  const stateValues = checkState(stateIds, state, issues);
  if (issues.length > 0) throw new SimulationInputError(issues);
  return { inputValues, stateValues };
}

function checkInputs(inputIds: readonly string[], inputs: unknown, issues: InputIssue[]): Bit[] {
  if (!isRecord(inputs)) {
    issues.push({ code: "MALFORMED_INPUTS", message: `Inputs must be an object mapping INPUT gate ids to 0 or 1, got ${showValue(inputs)}` });
    return [];
  }
  const values: Bit[] = [];
  for (const id of inputIds) {
    if (!Object.hasOwn(inputs, id)) {
      issues.push({ code: "MISSING_INPUT", message: `No value given for input ${quote(id)}`, inputId: id });
      continue;
    }
    const value = inputs[id];
    if (value === 0 || value === 1) values.push(value);
    else issues.push({ code: "INVALID_INPUT_VALUE", message: `Input ${quote(id)} must be 0 or 1, got ${showValue(value)}`, inputId: id });
  }
  for (const name of Object.keys(inputs)) {
    if (inputIds.includes(name)) continue;
    const expected = inputIds.length > 0 ? inputIds.map(quote).join(", ") : "none";
    issues.push({ code: "UNKNOWN_INPUT", message: `${quote(name)} is not an input of this circuit (inputs: ${expected})`, inputId: name });
  }
  return values;
}

/** A missing state means "nothing remembered yet": every gate starts at 0. */
function checkState(stateIds: readonly string[], state: unknown, issues: InputIssue[]): Map<string, Bit> {
  const values = new Map<string, Bit>();
  if (state === undefined) return values;
  if (!isRecord(state)) {
    issues.push({ code: "MALFORMED_STATE", message: `State must be an object mapping gate ids to 0 or 1, got ${showValue(state)}` });
    return values;
  }
  for (const [id, value] of Object.entries(state)) {
    if (!stateIds.includes(id)) {
      const holders = stateIds.length > 0 ? `only the gates on its feedback loops do: ${stateIds.map(quote).join(", ")}` : "it has no feedback loops";
      issues.push({ code: "UNKNOWN_STATE_GATE", message: `${quote(id)} holds no state in this circuit; ${holders}`, stateGateId: id });
    } else if (value === 0 || value === 1) {
      values.set(id, value);
    } else {
      issues.push({ code: "INVALID_STATE_VALUE", message: `The state of ${quote(id)} must be 0 or 1, got ${showValue(value)}`, stateGateId: id });
    }
  }
  return values;
}
