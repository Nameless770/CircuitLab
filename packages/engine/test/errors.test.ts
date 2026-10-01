import { CircuitLabError, CircuitValidationError, CycleError, OscillationError, SimulationInputError, reviveError } from "@circuitlab/engine";
import { describe, expect, it } from "vitest";

const errors = [
  new CircuitValidationError([
    { code: "DUPLICATE_GATE_ID", message: 'Gate id "A" is used twice', gateId: "A", gateIndex: 1 },
    { code: "UNCONNECTED_PIN", message: "Pin 1 of AND gate x has no wire", gateId: "x", gateIndex: 2, pin: 1 },
  ]),
  new CycleError(["q", "qbar", "q"]),
  new SimulationInputError([{ code: "MISSING_INPUT", message: 'Input "B" is missing', inputId: "B" }]),
  new SimulationInputError([{ code: "UNKNOWN_STATE_GATE", message: "x holds no state", stateGateId: "x" }]),
  new OscillationError(["n0", "n1", "n2"]),
];

describe("engine errors", () => {
  it.each(errors)("$name is a CircuitLabError, so callers can catch every engine error at once", (error) => {
    expect(error).toBeInstanceOf(CircuitLabError);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toBe("");
  });

  it.each(errors)("$name survives JSON (an HTTP body, a worker message, a job queue) and comes back as itself", (error) => {
    const revived = reviveError(JSON.parse(JSON.stringify(error)));
    expect(revived).toBeInstanceOf(error.constructor);
    expect(revived?.toJSON()).toEqual(error.toJSON());
  });

  it("summarizes every issue in the message", () => {
    expect(errors[0]?.message).toBe(
      'Circuit is invalid (2 issues):\n  - [DUPLICATE_GATE_ID] Gate id "A" is used twice\n  - [UNCONNECTED_PIN] Pin 1 of AND gate x has no wire',
    );
    expect(errors[1]?.message).toBe("Circuit contains a feedback loop: q -> qbar -> q");
  });

  it.each([
    null,
    "CycleError",
    { name: "TypeError", message: "x" },
    { name: "CycleError", cycle: [1, 2] },
    { name: "CircuitValidationError", issues: [{ code: "NOT_A_CODE", message: "x" }] },
    { name: "SimulationInputError", issues: "none" },
    { name: "OscillationError", gates: "n0" },
  ])("revives nothing from %j", (data) => {
    expect(reviveError(data)).toBeUndefined();
  });
});
