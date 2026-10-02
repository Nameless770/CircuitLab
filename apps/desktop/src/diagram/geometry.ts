import type { Gate, GateType, Wire } from "@circuitlab/engine";

/** Sizes and pin positions of gates in the diagram, shared by the drawing, the layout, and the editor. */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Input pins per gate type, fewest to most. This is a copy of the engine's GATE_ARITY: the
 * window's code only imports *types* from the backend packages (their code is built for Node), so the
 * numbers are repeated here, and test/geometry.test.ts checks they still match the engine.
 */
export const PIN_RANGE: Readonly<Record<GateType, { readonly min: number; readonly max: number }>> = {
  INPUT: { min: 0, max: 0 },
  CONST: { min: 0, max: 0 },
  OUTPUT: { min: 1, max: 1 },
  BUF: { min: 1, max: 1 },
  NOT: { min: 1, max: 1 },
  AND: { min: 2, max: 64 },
  OR: { min: 2, max: 64 },
  NAND: { min: 2, max: 64 },
  NOR: { min: 2, max: 64 },
  XOR: { min: 2, max: 64 },
  XNOR: { min: 2, max: 64 },
};

/**
 * How many input pins a gate has. Fixed for most types; for AND, OR and the others that take 2 to
 * 64 inputs, it's as many as are wired (at least 2).
 */
export function pinCount(gate: Gate, wires: readonly Wire[]): number {
  const { min, max } = PIN_RANGE[gate.type];
  if (min === max) return min;
  let highestPin = -1;
  for (const wire of wires) {
    if (wire.to === gate.id) highestPin = Math.max(highestPin, wire.toPin);
  }
  return Math.min(max, Math.max(min, highestPin + 1));
}

export function pinCounts(gates: readonly Gate[], wires: readonly Wire[]): Map<string, number> {
  return new Map(gates.map((gate) => [gate.id, pinCount(gate, wires)]));
}

/** Length of the short line drawn for each pin. */
export const PIN_LENGTH = 14;
/** Vertical distance between input pins on tall gates. */
const PIN_SPACING = 20;

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** The size of a gate's body (pins stick out of it by PIN_LENGTH). */
export function gateSize(type: GateType, pins: number): Size {
  switch (type) {
    case "INPUT":
      return { width: 44, height: 32 };
    case "CONST":
      return { width: 32, height: 28 };
    case "OUTPUT":
      return { width: 36, height: 36 };
    case "BUF":
    case "NOT":
      return { width: 48, height: 36 };
    default:
      return { width: 64, height: Math.max(44, pins * PIN_SPACING) };
  }
}

/** Where input pin `index` ends, relative to the gate's top-left corner. */
export function inputPinPoint(type: GateType, pins: number, index: number): Point {
  const { height } = gateSize(type, pins);
  return { x: -PIN_LENGTH, y: (height / pins) * (index + 0.5) };
}

/** Where the output pin ends, relative to the gate's top-left corner. */
export function outputPinPoint(type: GateType, pins: number): Point {
  const { width, height } = gateSize(type, pins);
  return { x: width + PIN_LENGTH, y: height / 2 };
}

export function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}
