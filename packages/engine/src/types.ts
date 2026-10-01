/** A single logic level. */
export type Bit = 0 | 1;

/**
 * Every gate type the engine understands. This array is the single source of truth:
 * the `GateType` union is derived from it, and runtime validation checks against it,
 * so the compile-time and runtime views of "valid gate type" can never drift apart.
 */
export const GATE_TYPES = [
  "INPUT",
  "OUTPUT",
  "CONST",
  "BUF",
  "NOT",
  "AND",
  "OR",
  "NAND",
  "NOR",
  "XOR",
  "XNOR",
] as const;

export type GateType = (typeof GATE_TYPES)[number];

/** Gates whose output is computed from their inputs (everything except sources and sinks). */
export type LogicGateType = Exclude<GateType, "INPUT" | "OUTPUT" | "CONST">;

interface GateBase {
  /** Unique within a circuit. For INPUT and OUTPUT gates it is also the name used by `simulate`. */
  readonly id: string;
  /** Display name for humans. The engine never reads it. */
  readonly label?: string;
}

/** External input. Its value is supplied at simulation time; it has no input pins. */
export interface InputGate extends GateBase {
  readonly type: "INPUT";
}

/** External output. Shows the signal on its single input pin and cannot drive other gates. */
export interface OutputGate extends GateBase {
  readonly type: "OUTPUT";
}

/** Fixed logic level (tie-high / tie-low). No input pins. */
export interface ConstGate extends GateBase {
  readonly type: "CONST";
  readonly value: Bit;
}

export interface LogicGate extends GateBase {
  readonly type: LogicGateType;
}

/** Discriminated union on `type`: checking `gate.type` narrows to the matching interface. */
export type Gate = InputGate | OutputGate | ConstGate | LogicGate;

/**
 * Connects the output of gate `from` to input pin `toPin` of gate `to`.
 * Every gate has exactly one output, so only the destination needs a pin number.
 * Pins are numbered from 0.
 */
export interface Wire {
  readonly id?: string;
  readonly from: string;
  readonly to: string;
  readonly toPin: number;
}

export interface Circuit {
  readonly name?: string;
  readonly gates: readonly Gate[];
  readonly wires: readonly Wire[];
}
