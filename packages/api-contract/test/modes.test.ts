import { openApi, parseSimulateRequest, simulationResponse, toProblem } from "@circuitlab/api-contract";
import { OscillationError, SIMULATION_MODES, combinational, sequential } from "@circuitlab/engine";
import { describe, expect, it } from "vitest";
import { fullAdder, srLatch } from "../../engine/test/fixtures";
import { expectConforms, issuesAt, problemOf, thrown } from "./helpers";

describe("simulation modes in the contract", () => {
  it("documents exactly the engine's modes", () => {
    const schemas = (openApi.components as { schemas: Record<string, { enum?: unknown[] }> }).schemas;
    expect(schemas.SimulationMode?.enum).toEqual([...SIMULATION_MODES]);
  });

  it("reads the mode and state, combinational by default", () => {
    expect(parseSimulateRequest({ inputs: { A: 1 } })).toEqual({ inputs: { A: 1 }, mode: "combinational" });
    expect(parseSimulateRequest({ inputs: { S: 0 }, mode: "sequential", state: { q: 1 } })).toEqual({ inputs: { S: 0 }, mode: "sequential", state: { q: 1 } });
    expect(issuesAt(problemOf(() => parseSimulateRequest({ inputs: {}, mode: "quantum" })))).toEqual(["INVALID_VALUE@/mode"]);
    expect(issuesAt(problemOf(() => parseSimulateRequest({ inputs: {}, state: [] })))).toEqual(["INVALID_TYPE@/state"]);
    // State values are left to the engine, which checks them against the circuit's loops.
    expect(parseSimulateRequest({ inputs: {}, mode: "sequential", state: { q: "1" } }).state).toEqual({ q: "1" });
  });

  it("locates state problems at /state", () => {
    const problem = toProblem(thrown(() => sequential.prepare(srLatch()).run({ S: 0, R: 0 }, { q: 2, S: 1 } as never)));
    expect([problem.status, problem.body.code]).toEqual([422, "invalid-inputs"]);
    expect(issuesAt(problem)).toEqual(["INVALID_STATE_VALUE@/state/q", "UNKNOWN_STATE_GATE@/state/S"]);
    expect(issuesAt(toProblem(thrown(() => sequential.prepare(srLatch()).run({ S: 0, R: 0 }, "x" as never))))).toEqual(["MALFORMED_STATE@/state"]);
  });

  it("answers a loop that never settles with 422 does-not-settle, one issue per gate", () => {
    const problem = toProblem(new OscillationError(["a", "b", "c"]));
    expect([problem.status, problem.body.code]).toEqual([422, "does-not-settle"]);
    expect(problem.body.issues?.map((issue) => issue.gateId)).toEqual(["a", "b", "c"]);
    expectConforms("Problem", problem.body);
  });

  it("answers with the mode, the state only in sequential mode, the order only in combinational", () => {
    const record = { id: "c1", version: 2 };
    const once = simulationResponse(record, combinational.prepare(fullAdder()).run({ A: 1, B: 1, Cin: 0 }), true);
    expect(Object.keys(once)).toEqual(["circuitId", "circuitVersion", "mode", "outputs", "signals", "order"]);
    const stepped = simulationResponse(record, sequential.prepare(srLatch()).run({ S: 1, R: 0 }), true);
    expect(Object.keys(stepped)).toEqual(["circuitId", "circuitVersion", "mode", "outputs", "state", "signals"]);
    expectConforms("SimulationResponse", once);
    expectConforms("SimulationResponse", stepped);
  });
});
