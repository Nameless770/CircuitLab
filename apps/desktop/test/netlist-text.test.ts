import type { Gate, Wire } from "@circuitlab/engine";
import { formatNetlist } from "@circuitlab/netlist";
import { describe, expect, it } from "vitest";
import c17Text from "../../../examples/netlists/c17.net?raw";
import fullAdderText from "../../../examples/netlists/full-adder.net?raw";
import halfAdderText from "../../../examples/netlists/half-adder.net?raw";
import srLatchText from "../../../examples/netlists/sr-latch.net?raw";
import { readNetlist } from "../electron/offline";
import { NETLIST_TEMPLATE, writeNetlist } from "../src/workspace/netlist-text";

// The netlist editor writes the drawing as text in the window (src/workspace/netlist-text.ts).
// For a finished circuit, that must be exactly what the netlist package writes.
const EXAMPLES = { "half adder": halfAdderText, "full adder": fullAdderText, "SR latch": srLatchText, c17: c17Text };

describe("writeNetlist", () => {
  for (const [name, text] of Object.entries(EXAMPLES)) {
    it(`writes the ${name} as the netlist package does`, () => {
      const circuit = readNetlist(text, "x");
      expect(writeNetlist(circuit)).toBe([...formatNetlist(circuit)].join(""));
    });
  }

  it("leaves an input pin with no wire empty, so the editor shows what is missing", () => {
    const gates: Gate[] = [
      { id: "A", type: "INPUT" },
      { id: "both", type: "AND" },
      { id: "Y", type: "OUTPUT" },
    ];
    const wires: Wire[] = [{ from: "A", to: "both", toPin: 0 }];
    // The drawing gave the AND gate 3 inputs, and only the first is wired; Y has none.
    const text = writeNetlist({ name: "Unfinished", gates, wires }, new Map([["both", 3]]));
    expect(text).toBe('.name "Unfinished"\nA = INPUT\nboth = AND(A, , )\nY = OUTPUT()\n');
  });

  it("writes constants and labels", () => {
    const text = writeNetlist({ name: "Odds", gates: [{ id: "one", type: "CONST", value: 1 }, { id: "Q", type: "OUTPUT", label: "The \"answer\"" }], wires: [{ from: "one", to: "Q", toPin: 0 }] });
    expect(text).toBe('.name "Odds"\none = CONST(1)\nQ = OUTPUT(one) "The \\"answer\\""\n');
  });
});

describe("NETLIST_TEMPLATE", () => {
  it("is a netlist that reads without mistakes", () => {
    const circuit = readNetlist(NETLIST_TEMPLATE, "x");
    expect(circuit.name).toBe("My circuit");
    expect(circuit.summary.outputs).toEqual(["Y"]);
  });
});
