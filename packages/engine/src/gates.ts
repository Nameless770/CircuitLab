import { GATE_TYPES, type Bit, type GateType } from "./types";

/** Upper bound on inputs for the variadic gates (AND, OR, NAND, NOR, XOR, XNOR). */
export const MAX_GATE_INPUTS = 64;

/** Allowed number of input pins, inclusive on both ends. */
export interface Arity {
  readonly min: number;
  readonly max: number;
}

/** Computes a gate's output from its input bits, ordered by pin number. */
export type Evaluator = (inputs: readonly Bit[]) => Bit;

/** Where a gate's output comes from. */
export type GateBehaviour =
  /** The value given for this input when simulating. */
  | { readonly kind: "input" }
  /** The gate's own `value`. */
  | { readonly kind: "const" }
  /** Computed from its input pins. */
  | { readonly kind: "logic"; readonly evaluate: Evaluator };

/** Everything the engine knows about one type of gate. */
export interface GateDefinition {
  readonly type: GateType;
  readonly arity: Arity;
  readonly behaviour: GateBehaviour;
  /** One sentence for people (documentation, demos). */
  readonly description: string;
}

const NO_INPUTS: Arity = { min: 0, max: 0 };
const ONE_INPUT: Arity = { min: 1, max: 1 };
const MANY_INPUTS: Arity = { min: 2, max: MAX_GATE_INPUTS };

const bit = (condition: boolean): Bit => (condition ? 1 : 0);

function countOnes(inputs: readonly Bit[]): number {
  let ones = 0;
  for (const input of inputs) ones += input;
  return ones;
}

/**
 * Evaluators receive the full pin-ordered list of inputs. The built-in gates are all symmetric
 * (the output only depends on how many inputs are 1), but an order-sensitive gate such as a
 * multiplexer fits the same shape.
 */
const logic = (evaluate: Evaluator): GateBehaviour => ({ kind: "logic", evaluate });
const copy: Evaluator = (inputs) => bit(countOnes(inputs) === inputs.length); // one input: its value

/**
 * The gate registry: one definition per gate type, and the only place that says how many inputs
 * a gate takes and what it computes. Validation, the netlist reader, and the gate factory
 * (gate-factory.ts) all read it. Typed as a full `Record<GateType, …>`, so adding a type to
 * GATE_TYPES is a compile error until it is defined here.
 */
export const GATE_DEFINITIONS: Readonly<Record<GateType, GateDefinition>> = {
  INPUT: { type: "INPUT", arity: NO_INPUTS, behaviour: { kind: "input" }, description: "An external input; its value is given when simulating." },
  CONST: { type: "CONST", arity: NO_INPUTS, behaviour: { kind: "const" }, description: "A fixed logic level, 0 or 1." },
  OUTPUT: { type: "OUTPUT", arity: ONE_INPUT, behaviour: logic(copy), description: "An external output; shows the signal on its input." },
  BUF: { type: "BUF", arity: ONE_INPUT, behaviour: logic(copy), description: "Copies its input." },
  NOT: { type: "NOT", arity: ONE_INPUT, behaviour: logic((inputs) => bit(countOnes(inputs) === 0)), description: "Inverts its input." },
  AND: { type: "AND", arity: MANY_INPUTS, behaviour: logic((inputs) => bit(countOnes(inputs) === inputs.length)), description: "1 when every input is 1." },
  OR: { type: "OR", arity: MANY_INPUTS, behaviour: logic((inputs) => bit(countOnes(inputs) > 0)), description: "1 when at least one input is 1." },
  NAND: { type: "NAND", arity: MANY_INPUTS, behaviour: logic((inputs) => bit(countOnes(inputs) < inputs.length)), description: "0 only when every input is 1." },
  NOR: { type: "NOR", arity: MANY_INPUTS, behaviour: logic((inputs) => bit(countOnes(inputs) === 0)), description: "1 only when every input is 0." },
  XOR: { type: "XOR", arity: MANY_INPUTS, behaviour: logic((inputs) => bit(countOnes(inputs) % 2 === 1)), description: "1 when an odd number of inputs are 1 (odd parity)." },
  XNOR: { type: "XNOR", arity: MANY_INPUTS, behaviour: logic((inputs) => bit(countOnes(inputs) % 2 === 0)), description: "1 when an even number of inputs are 1 (even parity)." },
};

/** Input pin counts per gate type, read from the registry. */
export const GATE_ARITY: Readonly<Record<GateType, Arity>> = Object.freeze(
  Object.fromEntries(GATE_TYPES.map((type) => [type, GATE_DEFINITIONS[type].arity])) as Record<GateType, Arity>,
);

export function isGateType(value: unknown): value is GateType {
  return typeof value === "string" && (GATE_TYPES as readonly string[]).includes(value);
}
