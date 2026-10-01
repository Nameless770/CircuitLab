import { GATE_TYPES, type Bit, type GateType, type LogicGateType } from "./types";

/** Upper bound on inputs for the variadic gates (AND, OR, NAND, NOR, XOR, XNOR). */
export const MAX_GATE_INPUTS = 64;

/** Allowed number of input pins, inclusive on both ends. */
export interface Arity {
  readonly min: number;
  readonly max: number;
}

const NO_INPUTS: Arity = { min: 0, max: 0 };
const ONE_INPUT: Arity = { min: 1, max: 1 };
const MANY_INPUTS: Arity = { min: 2, max: MAX_GATE_INPUTS };

/**
 * Input pin counts per gate type. Typed as a full `Record<GateType, …>`, so adding a
 * type to GATE_TYPES is a compile error until it gets an entry here.
 */
export const GATE_ARITY: Readonly<Record<GateType, Arity>> = {
  INPUT: NO_INPUTS,
  CONST: NO_INPUTS,
  OUTPUT: ONE_INPUT,
  BUF: ONE_INPUT,
  NOT: ONE_INPUT,
  AND: MANY_INPUTS,
  OR: MANY_INPUTS,
  NAND: MANY_INPUTS,
  NOR: MANY_INPUTS,
  XOR: MANY_INPUTS,
  XNOR: MANY_INPUTS,
};

/** Computes a gate's output from its input bits, ordered by pin number. */
export type Evaluator = (inputs: readonly Bit[]) => Bit;

const bit = (condition: boolean): Bit => (condition ? 1 : 0);

function countOnes(inputs: readonly Bit[]): number {
  let ones = 0;
  for (const input of inputs) ones += input;
  return ones;
}

/**
 * Logic for every computed gate type. The built-in gates are all symmetric (the output only
 * depends on how many inputs are 1), but evaluators receive the full pin-ordered list, so an
 * order-sensitive gate such as a multiplexer can be added later without changing this shape.
 */
export const GATE_LOGIC: Readonly<Record<LogicGateType, Evaluator>> = {
  BUF: (inputs) => bit(countOnes(inputs) === inputs.length), // copies its single input
  NOT: (inputs) => bit(countOnes(inputs) === 0), // inverts its single input
  AND: (inputs) => bit(countOnes(inputs) === inputs.length), // every input is 1
  OR: (inputs) => bit(countOnes(inputs) > 0), // at least one input is 1
  NAND: (inputs) => bit(countOnes(inputs) < inputs.length),
  NOR: (inputs) => bit(countOnes(inputs) === 0),
  XOR: (inputs) => bit(countOnes(inputs) % 2 === 1), // odd parity
  XNOR: (inputs) => bit(countOnes(inputs) % 2 === 0), // even parity
};

export function isGateType(value: unknown): value is GateType {
  return typeof value === "string" && (GATE_TYPES as readonly string[]).includes(value);
}
