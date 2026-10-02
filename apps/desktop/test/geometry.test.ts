import { GATE_ARITY, GATE_TYPES, type Gate, type Wire } from "@circuitlab/engine";
import { describe, expect, it } from "vitest";
import { PIN_RANGE, pinCount } from "../src/diagram/geometry";

describe("PIN_RANGE", () => {
  // The window only imports types from the engine, so it keeps its own copy of the pin counts.
  // This test fails if the engine's registry ever changes and the copy doesn't.
  it("matches the engine's gate registry", () => {
    for (const type of GATE_TYPES) expect(PIN_RANGE[type]).toEqual(GATE_ARITY[type]);
  });
});

describe("pinCount", () => {
  const and: Gate = { id: "g", type: "AND" };
  const wiresTo = (pins: number[]): Wire[] => pins.map((toPin) => ({ from: "A", to: "g", toPin }));

  it("is as many inputs as are wired", () => {
    expect(pinCount(and, wiresTo([0, 1, 2]))).toBe(3);
  });

  it("is at least the minimum (2 for AND) while wires are missing", () => {
    expect(pinCount(and, [])).toBe(2);
    expect(pinCount(and, wiresTo([0]))).toBe(2);
  });

  it("is fixed for gates with a fixed number of inputs", () => {
    expect(pinCount({ id: "n", type: "NOT" }, [])).toBe(1);
    expect(pinCount({ id: "i", type: "INPUT" }, [])).toBe(0);
  });
});
