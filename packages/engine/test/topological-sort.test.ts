import { CycleError, compileCircuit, topologicalSort, type Circuit } from "@circuitlab/engine";
import { describe, expect, it } from "vitest";
import { circuit, halfAdder, random, randomCircuit, rippleCarryAdder, srLatch } from "./fixtures";

/** Every gate after all the gates driving it. */
function expectDependencyOrder(source: Circuit, order: readonly string[]): void {
  const position = new Map(order.map((id, k) => [id, k]));
  expect(order).toHaveLength(source.gates.length);
  expect(new Set(order).size).toBe(order.length);
  for (const wire of source.wires) {
    expect(position.get(wire.from), `${wire.from} -> ${wire.to}`).toBeLessThan(position.get(wire.to) ?? -1);
  }
}

/** The CycleError a circuit throws when sorted. */
function cycleOf(source: Circuit): readonly string[] {
  try {
    topologicalSort(source);
  } catch (error) {
    if (error instanceof CycleError) return error.cycle;
    throw error;
  }
  throw new Error("expected a CycleError");
}

/** A reported loop must be real: closed, and each step an actual wire. */
function expectRealLoop(source: Circuit, cycle: readonly string[]): void {
  expect(cycle.length).toBeGreaterThanOrEqual(2);
  expect(cycle.at(-1)).toBe(cycle[0]);
  for (let k = 0; k + 1 < cycle.length; k++) {
    expect(source.wires.some((wire) => wire.from === cycle[k] && wire.to === cycle[k + 1]), `${cycle[k]} -> ${cycle[k + 1]} is a wire`).toBe(true);
  }
}

describe("topologicalSort (Kahn's algorithm)", () => {
  it("returns a circuit already in a valid order unchanged", () => {
    expect(topologicalSort(halfAdder())).toEqual(["A", "B", "sum", "carry", "S", "C"]);
  });

  it("puts each gate after its drivers when they are declared later", () => {
    const adder = rippleCarryAdder(4); // outputs are declared before the logic that drives them
    expectDependencyOrder(adder, topologicalSort(adder));
  });

  it("breaks ties by declaration order, so the result is deterministic", () => {
    // Every gate depends only on A; all of them become ready at once, and come out as declared.
    const fan = circuit("fan-out", ["A", "INPUT"], ["z", "NOT", "A"], ["m", "BUF", "A"], ["b", "NOT", "A"], ["Z", "OUTPUT", "z"], ["M", "OUTPUT", "m"], ["B", "OUTPUT", "b"]);
    expect(topologicalSort(fan)).toEqual(["A", "z", "m", "b", "Z", "M", "B"]);
    expect(topologicalSort(fan)).toEqual(topologicalSort(fan));
  });

  it("orders 200 random circuits correctly", () => {
    const next = random(7);
    for (let n = 0; n < 200; n++) {
      const source = randomCircuit(next, 1 + Math.floor(next() * 6), Math.floor(next() * 40));
      expectDependencyOrder(source, topologicalSort(source));
    }
  });

  it("handles a chain of 100,000 gates without running out of stack", () => {
    const chain: Parameters<typeof circuit>[1][] = [["g0", "INPUT"]];
    for (let k = 1; k < 100_000; k++) chain.push([`g${k}`, "BUF", `g${k - 1}`]);
    chain.push(["Y", "OUTPUT", "g99999"]);
    const order = topologicalSort(circuit("chain", ...chain));
    expect(order[0]).toBe("g0");
    expect(order.at(-1)).toBe("Y");
  });
});

describe("feedback loops", () => {
  it("names the loop of an SR latch", () => {
    const latch = srLatch();
    const cycle = cycleOf(latch);
    expectRealLoop(latch, cycle);
    expect(new Set(cycle)).toEqual(new Set(["q", "qbar"]));
  });

  it("finds a gate feeding itself", () => {
    const source = circuit("self loop", ["A", "INPUT"], ["x", "AND", "A", "x"], ["Y", "OUTPUT", "x"]);
    expect(cycleOf(source)).toEqual(["x", "x"]);
  });

  it("reports only the gates on the loop, not those merely downstream of it", () => {
    // in -> a -> b -> c -> a (the loop), and c -> d -> out (downstream).
    const source = circuit(
      "loop with a tail",
      ["in", "INPUT"],
      ["a", "OR", "in", "c"],
      ["b", "BUF", "a"],
      ["c", "BUF", "b"],
      ["d", "NOT", "c"],
      ["out", "OUTPUT", "d"],
    );
    const cycle = cycleOf(source);
    expectRealLoop(source, cycle);
    expect(new Set(cycle)).toEqual(new Set(["a", "b", "c"]));
  });

  it("is also what compileCircuit throws", () => {
    expect(() => compileCircuit(srLatch())).toThrow(CycleError);
  });
});
