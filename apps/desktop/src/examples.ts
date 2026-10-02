// The example netlists from examples/netlists, built into the app (Vite's "?raw" import turns a
// file into a string at build time), so they work offline and online alike.
import c17 from "../../../examples/netlists/c17.net?raw";
import fullAdder from "../../../examples/netlists/full-adder.net?raw";
import halfAdder from "../../../examples/netlists/half-adder.net?raw";
import srLatch from "../../../examples/netlists/sr-latch.net?raw";

export interface Example {
  readonly name: string;
  readonly description: string;
  readonly netlist: string;
}

export const EXAMPLES: readonly Example[] = [
  { name: "Half adder", description: "Adds two bits: XOR for the sum, AND for the carry.", netlist: halfAdder },
  { name: "Full adder", description: "Adds three bits, the building block of every adder.", netlist: fullAdder },
  { name: "SR latch", description: "Two NOR gates feeding each other: a circuit that remembers.", netlist: srLatch },
  { name: "ISCAS-85 c17", description: "The classic six-NAND benchmark circuit.", netlist: c17 },
];
