import { CircuitValidationError, assertValidCircuit, validateCircuit, type ValidationIssue } from "@circuitlab/engine";
import { describe, expect, it } from "vitest";
import { c17, fullAdder, halfAdder, rippleCarryAdder, srLatch } from "./fixtures";

/** The issues without their messages: the code and location are what callers rely on. */
const located = (issues: readonly ValidationIssue[]): Omit<ValidationIssue, "message">[] => issues.map(({ message: _, ...rest }) => rest);

const A = { id: "A", type: "INPUT" };
const Y = { id: "Y", type: "OUTPUT" };
const AtoY = { from: "A", to: "Y", toPin: 0 };

describe("validateCircuit", () => {
  it("accepts valid circuits, including one with a feedback loop (that is a sorting matter)", () => {
    for (const circuit of [halfAdder(), fullAdder(), c17(), rippleCarryAdder(8), srLatch()]) expect(validateCircuit(circuit)).toEqual([]);
  });

  it.each([null, undefined, 42, "circuit", [], true])("treats %j as untrusted input, without throwing", (input) => {
    expect(located(validateCircuit(input))).toEqual([{ code: "MALFORMED_CIRCUIT" }]);
  });

  it("reports both arrays when both are missing", () => {
    expect(located(validateCircuit({ gates: "all of them", wires: 3 }))).toEqual([{ code: "MALFORMED_CIRCUIT" }, { code: "MALFORMED_CIRCUIT" }]);
  });

  // One mistake per circuit, and where the engine says it is.
  it.each<[string, unknown, Omit<ValidationIssue, "message">[]]>([
    ["a name that isn't text", { name: 7, gates: [A, Y], wires: [AtoY] }, [{ code: "MALFORMED_CIRCUIT" }]],
    ["a gate that isn't an object", { gates: [A, "B", Y], wires: [AtoY] }, [{ code: "MALFORMED_GATE", gateIndex: 1 }]],
    ["a gate without an id", { gates: [A, { type: "NOT" }, Y], wires: [AtoY] }, [{ code: "MALFORMED_GATE", gateIndex: 1 }]],
    ["two gates with one id", { gates: [A, { id: "A", type: "INPUT" }, Y], wires: [AtoY] }, [{ code: "DUPLICATE_GATE_ID", gateId: "A", gateIndex: 1 }]],
    ["an unknown gate type", { gates: [A, { id: "m", type: "MAJORITY" }, Y], wires: [AtoY] }, [{ code: "UNKNOWN_GATE_TYPE", gateId: "m", gateIndex: 1 }]],
    ["a CONST of 2", { gates: [{ id: "k", type: "CONST", value: 2 }, Y], wires: [{ from: "k", to: "Y", toPin: 0 }] }, [{ code: "INVALID_CONST_VALUE", gateId: "k", gateIndex: 0 }]],
    ["a wire that isn't an object", { gates: [A, Y], wires: [AtoY, null] }, [{ code: "MALFORMED_WIRE", wireIndex: 1 }]],
    ["a wire from nowhere", { gates: [A, Y], wires: [{ from: "ghost", to: "Y", toPin: 0 }] }, [{ code: "UNKNOWN_SOURCE_GATE", wireIndex: 0 }]],
    ["a wire to nowhere", { gates: [A, Y], wires: [AtoY, { from: "A", to: "ghost", toPin: 0 }] }, [{ code: "UNKNOWN_TARGET_GATE", wireIndex: 1 }]],
    ["an OUTPUT driving something", { gates: [A, Y, { id: "Z", type: "OUTPUT" }], wires: [AtoY, { from: "Y", to: "Z", toPin: 0 }] }, [{ code: "OUTPUT_AS_SOURCE", wireIndex: 1 }]],
    ["a NOT's second pin", { gates: [A, { id: "n", type: "NOT" }, Y], wires: [{ from: "A", to: "n", toPin: 0 }, { from: "A", to: "n", toPin: 1 }, { from: "n", to: "Y", toPin: 0 }] }, [{ code: "PIN_OUT_OF_RANGE", gateId: "n", wireIndex: 1, pin: 1 }]],
    ["two wires into one pin", { gates: [A, { id: "B", type: "INPUT" }, Y], wires: [AtoY, { from: "B", to: "Y", toPin: 0 }] }, [{ code: "MULTIPLE_DRIVERS", gateId: "Y", wireIndex: 1, pin: 0 }]],
    ["an AND with one input", { gates: [A, { id: "and", type: "AND" }, Y], wires: [{ from: "A", to: "and", toPin: 0 }, { from: "and", to: "Y", toPin: 0 }] }, [{ code: "UNCONNECTED_PIN", gateId: "and", gateIndex: 1, pin: 1 }]],
    ["an OUTPUT with nothing on it", { gates: [A, Y], wires: [] }, [{ code: "UNCONNECTED_PIN", gateId: "Y", gateIndex: 1, pin: 0 }]],
  ])("finds %s", (_, circuit, expected) => {
    const issues = validateCircuit(circuit);
    expect(located(issues)).toMatchObject(expected);
    expect(issues).toHaveLength(expected.length);
    for (const issue of issues) expect(issue.message).not.toBe("");
  });

  it("reports every problem at once, not just the first", () => {
    const circuit = {
      gates: [A, A, { id: "m", type: "MAJORITY" }, { id: "k", type: "CONST", value: 5 }, Y],
      wires: [{ from: "ghost", to: "Y", toPin: 0 }, AtoY],
    };
    const codes = validateCircuit(circuit).map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(["DUPLICATE_GATE_ID", "UNKNOWN_GATE_TYPE", "INVALID_CONST_VALUE", "UNKNOWN_SOURCE_GATE"]));
  });

  it("doesn't trip over ids that are Object.prototype properties", () => {
    const circuit = {
      gates: [{ id: "__proto__", type: "INPUT" }, { id: "constructor", type: "NOT" }, { id: "toString", type: "OUTPUT" }],
      wires: [{ from: "__proto__", to: "constructor", toPin: 0 }, { from: "constructor", to: "toString", toPin: 0 }],
    };
    expect(validateCircuit(circuit)).toEqual([]);
  });
});

describe("assertValidCircuit", () => {
  it("throws one error carrying every issue", () => {
    const error = (() => {
      try {
        assertValidCircuit({ gates: [A, A], wires: "none" });
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(CircuitValidationError);
    expect((error as CircuitValidationError).issues.map((issue) => issue.code)).toEqual(["MALFORMED_CIRCUIT", "DUPLICATE_GATE_ID"]);
    expect((error as Error).message).toMatch(/^Circuit is invalid \(2 issues\):/);
  });
});
