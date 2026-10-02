import type { Gate, Wire } from "@circuitlab/engine";
import { describe, expect, it } from "vitest";
import { gateSize, pinCount } from "../src/diagram/geometry";
import { autoLayout } from "../src/diagram/layout";

const halfAdder: { gates: Gate[]; wires: Wire[] } = {
  gates: [
    { id: "A", type: "INPUT" },
    { id: "B", type: "INPUT" },
    { id: "sum", type: "XOR" },
    { id: "carry", type: "AND" },
    { id: "S", type: "OUTPUT" },
    { id: "C", type: "OUTPUT" },
  ],
  wires: [
    { from: "A", to: "sum", toPin: 0 },
    { from: "B", to: "sum", toPin: 1 },
    { from: "A", to: "carry", toPin: 0 },
    { from: "B", to: "carry", toPin: 1 },
    { from: "sum", to: "S", toPin: 0 },
    { from: "carry", to: "C", toPin: 0 },
  ],
};

// Two NOR gates feeding each other: neither is ever "ready" before the other.
const srLatch: { gates: Gate[]; wires: Wire[] } = {
  gates: [
    { id: "S", type: "INPUT" },
    { id: "R", type: "INPUT" },
    { id: "q", type: "NOR" },
    { id: "qbar", type: "NOR" },
    { id: "out_q", type: "OUTPUT" },
  ],
  wires: [
    { from: "R", to: "q", toPin: 0 },
    { from: "qbar", to: "q", toPin: 1 },
    { from: "S", to: "qbar", toPin: 0 },
    { from: "q", to: "qbar", toPin: 1 },
    { from: "q", to: "out_q", toPin: 0 },
  ],
};

function x(positions: Map<string, { x: number }>, id: string): number {
  return positions.get(id)?.x ?? Number.NaN;
}

/** No two gates in the same column may overlap (including the room for the name under them). */
function expectNoOverlaps(circuit: { gates: Gate[]; wires: Wire[] }, positions: Map<string, { x: number; y: number }>): void {
  const boxes = circuit.gates.map((gate) => {
    const at = positions.get(gate.id) ?? { x: 0, y: 0 };
    const { height } = gateSize(gate.type, pinCount(gate, circuit.wires));
    return { x: at.x, top: at.y, bottom: at.y + height };
  });
  for (const a of boxes) {
    for (const b of boxes) {
      if (a !== b && a.x === b.x) expect(a.bottom <= b.top || b.bottom <= a.top).toBe(true);
    }
  }
}

describe("autoLayout", () => {
  it("puts inputs first, then the gates, then the outputs, left to right", () => {
    const positions = autoLayout(halfAdder.gates, halfAdder.wires);
    expect(x(positions, "A")).toBe(x(positions, "B"));
    expect(x(positions, "sum")).toBe(x(positions, "carry"));
    expect(x(positions, "S")).toBe(x(positions, "C"));
    expect(x(positions, "A")).toBeLessThan(x(positions, "sum"));
    expect(x(positions, "sum")).toBeLessThan(x(positions, "S"));
  });

  it("gives every gate a place, and no two gates overlap", () => {
    const positions = autoLayout(halfAdder.gates, halfAdder.wires);
    expect([...positions.keys()].sort()).toEqual(halfAdder.gates.map((gate) => gate.id).sort());
    expectNoOverlaps(halfAdder, positions);
  });

  it("places the gates of a feedback loop instead of waiting forever", () => {
    const positions = autoLayout(srLatch.gates, srLatch.wires);
    expect(positions.size).toBe(srLatch.gates.length);
    expect(x(positions, "out_q")).toBeGreaterThan(x(positions, "q"));
    expect(x(positions, "out_q")).toBeGreaterThan(x(positions, "qbar"));
    expectNoOverlaps(srLatch, positions);
  });

  it("copes with gates that aren't connected yet (in the editor)", () => {
    const gates: Gate[] = [
      { id: "and1", type: "AND" },
      { id: "Y", type: "OUTPUT" },
    ];
    const positions = autoLayout(gates, []);
    expect(positions.size).toBe(2);
    expect(x(positions, "Y")).toBeGreaterThan(x(positions, "and1"));
  });

  it("returns nothing for an empty circuit", () => {
    expect(autoLayout([], []).size).toBe(0);
  });
});
