import { GATE_ARITY, GATE_DEFINITIONS, GATE_TYPES, createGateNode, type Gate } from "@circuitlab/engine";
import { describe, expect, it } from "vitest";
import { stronglyConnectedComponents } from "../dist/components";
import { random } from "./fixtures";

describe("the gate registry", () => {
  it("defines every gate type, and nothing else", () => {
    expect(Object.keys(GATE_DEFINITIONS).sort()).toEqual([...GATE_TYPES].sort());
    for (const type of GATE_TYPES) {
      expect(GATE_DEFINITIONS[type].type).toBe(type);
      expect(GATE_ARITY[type]).toBe(GATE_DEFINITIONS[type].arity); // derived, not a second copy
      expect(GATE_DEFINITIONS[type].description).not.toBe("");
    }
  });
});

describe("the gate factory", () => {
  const make = (gate: Gate, sources: number[] = []) => createGateNode(gate, 7, sources, 3);

  it("makes an input node that reads the circuit's input by position", () => {
    expect(make({ id: "A", type: "INPUT" })).toEqual({ kind: "input", slot: 7, input: 3 });
  });

  it("makes a constant node with the gate's value", () => {
    expect(make({ id: "one", type: "CONST", value: 1 })).toEqual({ kind: "const", slot: 7, value: 1 });
  });

  it("makes logic nodes that compute from their pins, an OUTPUT copying its input", () => {
    const output = make({ id: "Y", type: "OUTPUT" }, [2]);
    const nand = make({ id: "n", type: "NAND" }, [0, 1]);
    if (output.kind !== "logic" || nand.kind !== "logic") throw new Error("expected logic nodes");
    expect(output.sources).toEqual([2]);
    expect([output.evaluate([0]), output.evaluate([1])]).toEqual([0, 1]);
    expect([nand.evaluate([1, 1]), nand.evaluate([0, 1])]).toEqual([0, 1]);
  });
});

/** All nodes reachable from `start`. */
function reachable(successors: readonly (readonly number[])[], start: number): Set<number> {
  const seen = new Set([start]);
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    for (const next of successors[queue[head] ?? 0] ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

describe("strongly connected components (Tarjan's algorithm)", () => {
  it("finds the loops of a small graph, in dependency order", () => {
    // 0 -> 1 -> 2 -> 1 (a loop of 1 and 2), 2 -> 3, 3 -> 3 (a self-loop), 4 alone.
    expect(stronglyConnectedComponents([[1], [2], [1, 3], [3], []])).toEqual([[4], [0], [1, 2], [3]]);
  });

  it("is right on 300 random graphs: members reach each other, and order follows the edges", () => {
    const next = random(17);
    for (let n = 0; n < 300; n++) {
      const size = 1 + Math.floor(next() * 25);
      const successors = Array.from({ length: size }, () => Array.from({ length: Math.floor(next() * 3) }, () => Math.floor(next() * size)));
      const components = stronglyConnectedComponents(successors);
      expect(components.flat().sort((a, b) => a - b)).toEqual(Array.from({ length: size }, (_, k) => k));
      const componentOf = new Map(components.flatMap((members, k) => members.map((member) => [member, k])));
      const reach = successors.map((_, node) => reachable(successors, node));
      for (let u = 0; u < size; u++) {
        for (let v = 0; v < size; v++) {
          const together = reach[u]?.has(v) === true && reach[v]?.has(u) === true;
          expect(componentOf.get(u) === componentOf.get(v), `${u} and ${v}`).toBe(together);
        }
        for (const v of successors[u] ?? []) expect(componentOf.get(u) ?? 0).toBeLessThanOrEqual(componentOf.get(v) ?? 0);
      }
    }
  });

  it("handles a chain of 100,000 nodes without running out of stack", () => {
    const chain = Array.from({ length: 100_000 }, (_, k) => (k + 1 < 100_000 ? [k + 1] : [0])); // one big loop
    expect(stronglyConnectedComponents(chain)).toHaveLength(1);
  });
});
