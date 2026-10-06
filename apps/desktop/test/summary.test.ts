import type { Gate, Wire } from "@circuitlab/engine";
import { describe, expect, it } from "vitest";
import c17Text from "../../../examples/netlists/c17.net?raw";
import fullAdderText from "../../../examples/netlists/full-adder.net?raw";
import halfAdderText from "../../../examples/netlists/half-adder.net?raw";
import srLatchText from "../../../examples/netlists/sr-latch.net?raw";
import { readNetlist } from "../electron/offline";
import { describeSummary, findLoop, summarize } from "../src/workspace/summary";

// The window's own summary (src/workspace/summary.ts), checked against the engine's, which the
// main process computes when it reads a netlist.
const EXAMPLES = { "half adder": halfAdderText, "full adder": fullAdderText, "SR latch": srLatchText, c17: c17Text };

/** True if every step of `loop` follows a wire, and it ends where it started. */
function isRealLoop(loop: readonly string[], wires: readonly Wire[]): boolean {
  if (loop.length < 2 || loop[0] !== loop.at(-1)) return false;
  return loop.slice(1).every((to, index) => wires.some((wire) => wire.from === loop[index] && wire.to === to));
}

describe("summarize", () => {
  for (const [name, text] of Object.entries(EXAMPLES)) {
    it(`agrees with the engine about the ${name}`, () => {
      const circuit = readNetlist(text, "x");
      const mine = summarize(circuit.gates, circuit.wires);
      expect(mine.inputs).toEqual(circuit.summary.inputs);
      expect(mine.outputs).toEqual(circuit.summary.outputs);
      // Both find a loop, or neither does. (They may start the loop at different gates.)
      expect(mine.feedbackLoop === null).toBe(circuit.summary.feedbackLoop === null);
      if (mine.feedbackLoop !== null) expect(isRealLoop(mine.feedbackLoop, circuit.wires)).toBe(true);
    });
  }
});

describe("findLoop", () => {
  const not = (id: string): Gate => ({ id, type: "NOT" });
  const wire = (from: string, to: string): Wire => ({ from, to, toPin: 0 });

  it("finds a loop of one gate feeding itself", () => {
    expect(findLoop([not("a")], [wire("a", "a")])).toEqual(["a", "a"]);
  });

  it("finds a loop that only part of the circuit is on", () => {
    const gates = ["a", "b", "c", "d"].map(not);
    const wires = [wire("a", "b"), wire("b", "c"), wire("c", "b"), wire("c", "d")];
    const loop = findLoop(gates, wires);
    expect(loop).not.toBeNull();
    expect(isRealLoop(loop ?? [], wires)).toBe(true);
  });

  it("is null for a circuit without one, and for wires to gates that were deleted", () => {
    expect(findLoop([not("a"), not("b")], [wire("a", "b")])).toBeNull();
    expect(findLoop([not("a")], [wire("a", "gone"), wire("gone", "a")])).toBeNull();
    expect(findLoop([], [])).toBeNull();
  });

  it("copes with a chain of 10,000 gates without running out of stack", () => {
    const gates = Array.from({ length: 10_000 }, (_, index) => not(`g${index}`));
    const wires = gates.slice(1).map((gate, index) => wire(`g${index}`, gate.id));
    expect(findLoop(gates, wires)).toBeNull();
    expect(findLoop(gates, [...wires, wire("g9999", "g0")])).toHaveLength(10_001);
  });
});

describe("describeSummary", () => {
  it("says what the circuit has, in a sentence", () => {
    expect(describeSummary({ inputs: ["A", "B"], outputs: ["S", "C"], feedbackLoop: null }, 6)).toBe("6 gates, inputs A, B → outputs S, C.");
    expect(describeSummary({ inputs: [], outputs: [], feedbackLoop: null }, 1)).toBe("1 gate, no inputs → no outputs.");
  });

  it("explains a loop", () => {
    expect(describeSummary({ inputs: ["S", "R"], outputs: ["q"], feedbackLoop: ["q", "qbar", "q"] }, 6)).toContain("It has a feedback loop (q → qbar → q), so it's simulated step by step.");
  });
});
