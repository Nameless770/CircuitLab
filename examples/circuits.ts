import type { Bit, Circuit, Gate, Wire } from "@circuitlab/engine";

/**
 * An n-bit ripple-carry adder: n full adders in a chain, each passing its carry to the next.
 * 8 gates per bit, so it produces test circuits of any size.
 *
 * Inputs are declared a(n-1)..a0, b(n-1)..b0, cin, so a truth-table row number reads as
 * A, B, and cin written one after the other in binary. Outputs are declared cout, s(n-1)..s0,
 * so the output bits, in order, spell the sum in binary.
 */
export function rippleCarryAdder(bits: number): Circuit {
  const gates: Gate[] = [];
  const wires: Wire[] = [];
  const add = (gate: Gate, ...sources: string[]): void => {
    gates.push(gate);
    sources.forEach((from, toPin) => wires.push({ from, to: gate.id, toPin }));
  };

  for (let i = bits - 1; i >= 0; i--) add({ id: `a${i}`, type: "INPUT" });
  for (let i = bits - 1; i >= 0; i--) add({ id: `b${i}`, type: "INPUT" });
  add({ id: "cin", type: "INPUT" });

  add({ id: "cout", type: "OUTPUT" }, `c${bits}`);
  for (let i = bits - 1; i >= 0; i--) add({ id: `s${i}`, type: "OUTPUT" }, `x${i}`);

  let carry = "cin";
  for (let i = 0; i < bits; i++) {
    add({ id: `x${i}`, type: "XOR" }, `a${i}`, `b${i}`, carry); // sum bit: odd parity
    add({ id: `ab${i}`, type: "AND" }, `a${i}`, `b${i}`);
    add({ id: `ac${i}`, type: "AND" }, `a${i}`, carry);
    add({ id: `bc${i}`, type: "AND" }, `b${i}`, carry);
    add({ id: `c${i + 1}`, type: "OR" }, `ab${i}`, `ac${i}`, `bc${i}`); // carry out: majority
    carry = `c${i + 1}`;
  }
  return { name: `${bits}-bit ripple-carry adder`, gates, wires };
}

/** The n lowest bits of `value`, most significant first. */
export function toBits(value: bigint, n: number): Bit[] {
  return Array.from({ length: n }, (_, k) => ((value >> BigInt(n - 1 - k)) & 1n ? 1 : 0));
}

/** Reads bits, most significant first, as a number. */
export function fromBits(bits: readonly Bit[]): bigint {
  return bits.reduce<bigint>((value, bit) => (value << 1n) | BigInt(bit), 0n);
}

export function section(title: string): void {
  console.log(`\n=== ${title} ${"=".repeat(Math.max(3, 72 - title.length))}\n`);
}

export function print(text: string): void {
  console.log(text.replace(/^(?=.)/gm, "  "));
}
