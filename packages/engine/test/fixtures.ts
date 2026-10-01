// Circuits with known behaviour, and the tools to build more. Each circuit comes with an
// independent reference (plain arithmetic or boolean logic) for the tests to compare against.

import type { Bit, Circuit, Gate, GateType, Wire } from "@circuitlab/engine";

/** A gate and the gates driving its input pins, in pin order. `CONST0`/`CONST1` are constants. */
export type GateSpec = readonly [id: string, type: GateType | "CONST0" | "CONST1", ...sources: string[]];

/** Builds a circuit from gate specs, wiring each source to the next free pin. */
export function circuit(name: string, ...specs: GateSpec[]): Circuit {
  const gates: Gate[] = [];
  const wires: Wire[] = [];
  for (const [id, type, ...sources] of specs) {
    if (type === "CONST0" || type === "CONST1") gates.push({ id, type: "CONST", value: type === "CONST1" ? 1 : 0 });
    else gates.push({ id, type } as Gate);
    sources.forEach((from, toPin) => wires.push({ from, to: id, toPin }));
  }
  return { name, gates, wires };
}

export const halfAdder = (): Circuit =>
  circuit("Half adder", ["A", "INPUT"], ["B", "INPUT"], ["sum", "XOR", "A", "B"], ["carry", "AND", "A", "B"], ["S", "OUTPUT", "sum"], ["C", "OUTPUT", "carry"]);

export const fullAdder = (): Circuit =>
  circuit(
    "Full adder",
    ["A", "INPUT"],
    ["B", "INPUT"],
    ["Cin", "INPUT"],
    ["parity", "XOR", "A", "B", "Cin"],
    ["ab", "AND", "A", "B"],
    ["ac", "AND", "A", "Cin"],
    ["bc", "AND", "B", "Cin"],
    ["majority", "OR", "ab", "ac", "bc"],
    ["S", "OUTPUT", "parity"],
    ["Cout", "OUTPUT", "majority"],
  );

/** A 2-to-1 multiplexer: Y = sel ? b : a, from NOT, AND, and OR. */
export const multiplexer = (): Circuit =>
  circuit(
    "2:1 multiplexer",
    ["a", "INPUT"],
    ["b", "INPUT"],
    ["sel", "INPUT"],
    ["nsel", "NOT", "sel"],
    ["pickA", "AND", "a", "nsel"],
    ["pickB", "AND", "b", "sel"],
    ["y", "OR", "pickA", "pickB"],
    ["Y", "OUTPUT", "y"],
  );

/** ISCAS-85 c17, the classic six-NAND benchmark. */
export const c17 = (): Circuit =>
  circuit(
    "c17",
    ["N1", "INPUT"],
    ["N2", "INPUT"],
    ["N3", "INPUT"],
    ["N6", "INPUT"],
    ["N7", "INPUT"],
    ["N10", "NAND", "N1", "N3"],
    ["N11", "NAND", "N3", "N6"],
    ["N16", "NAND", "N2", "N11"],
    ["N19", "NAND", "N11", "N7"],
    ["N22", "NAND", "N10", "N16"],
    ["N23", "NAND", "N16", "N19"],
    ["O22", "OUTPUT", "N22"],
    ["O23", "OUTPUT", "N23"],
  );

/** c17 written as plain boolean logic, to check the circuit against. */
export function c17Reference(n1: boolean, n2: boolean, n3: boolean, n6: boolean, n7: boolean): [boolean, boolean] {
  const nand = (a: boolean, b: boolean): boolean => !(a && b);
  const n10 = nand(n1, n3);
  const n11 = nand(n3, n6);
  const n16 = nand(n2, n11);
  const n19 = nand(n11, n7);
  return [nand(n10, n16), nand(n16, n19)];
}

/** Two cross-coupled NOR gates: a latch, so a feedback loop q -> qbar -> q. */
export const srLatch = (): Circuit =>
  circuit("SR latch", ["S", "INPUT"], ["R", "INPUT"], ["q", "NOR", "R", "qbar"], ["qbar", "NOR", "S", "q"], ["Q", "OUTPUT", "q"]);

/**
 * An n-bit ripple-carry adder. Inputs a(n-1)..a0, b(n-1)..b0, cin, so a truth-table row number
 * spells A, B, and cin in binary; outputs cout, s(n-1)..s0, so the output bits spell the sum.
 * Gates are declared outputs first, so the evaluation order differs from declaration order.
 */
export function rippleCarryAdder(bits: number): Circuit {
  const specs: GateSpec[] = [];
  for (let i = bits - 1; i >= 0; i--) specs.push([`a${i}`, "INPUT"]);
  for (let i = bits - 1; i >= 0; i--) specs.push([`b${i}`, "INPUT"]);
  specs.push(["cin", "INPUT"], ["cout", "OUTPUT", `c${bits}`]);
  for (let i = bits - 1; i >= 0; i--) specs.push([`s${i}`, "OUTPUT", `x${i}`]);
  let carry = "cin";
  for (let i = 0; i < bits; i++) {
    specs.push(
      [`x${i}`, "XOR", `a${i}`, `b${i}`, carry],
      [`ab${i}`, "AND", `a${i}`, `b${i}`],
      [`ac${i}`, "AND", `a${i}`, carry],
      [`bc${i}`, "AND", `b${i}`, carry],
      [`c${i + 1}`, "OR", `ab${i}`, `ac${i}`, `bc${i}`],
    );
    carry = `c${i + 1}`;
  }
  return circuit(`${bits}-bit ripple-carry adder`, ...specs);
}

/** The `n` lowest bits of `value`, most significant first. */
export function toBits(value: bigint, n: number): Bit[] {
  return Array.from({ length: n }, (_, k) => ((value >> BigInt(n - 1 - k)) & 1n ? 1 : 0));
}

/** Bits, most significant first, as a number. */
export function fromBits(bits: readonly Bit[]): bigint {
  return bits.reduce<bigint>((value, bit) => (value << 1n) | BigInt(bit), 0n);
}

/**
 * A small seeded random number generator (mulberry32). Random tests use it so that a failure can
 * be reproduced: the same seed gives the same "random" circuits and inputs every run.
 */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/**
 * A random loop-free circuit: each logic gate takes its inputs only from gates declared before it,
 * so there can't be a cycle. Every INPUT and logic gate also drives an OUTPUT, so all of it matters.
 */
export function randomCircuit(next: () => number, inputs: number, logicGates: number): Circuit {
  const types: GateType[] = ["AND", "OR", "NAND", "NOR", "XOR", "XNOR", "NOT", "BUF"];
  const specs: GateSpec[] = [];
  const signals: string[] = [];
  for (let i = 0; i < inputs; i++) {
    specs.push([`in${i}`, "INPUT"]);
    signals.push(`in${i}`);
  }
  for (let g = 0; g < logicGates; g++) {
    const type = types[Math.floor(next() * types.length)] ?? "AND";
    const pins = type === "NOT" || type === "BUF" ? 1 : 2 + Math.floor(next() * 3);
    const sources = Array.from({ length: pins }, () => signals[Math.floor(next() * signals.length)] ?? "in0");
    specs.push([`g${g}`, type, ...sources]);
    signals.push(`g${g}`);
  }
  signals.forEach((signal, k) => specs.push([`out${k}`, "OUTPUT", signal]));
  return circuit("random", ...specs);
}
