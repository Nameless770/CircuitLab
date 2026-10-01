import {
  CycleError,
  OscillationError,
  SIMULATION_MODES,
  SimulationInputError,
  combinational,
  sequential,
  sequentialStrategy,
  simulationStrategy,
  type Bit,
  type Circuit,
  type SequentialResult,
  type SimulationState,
} from "@circuitlab/engine";
import { describe, expect, it } from "vitest";
import { dFlipFlop, dLatch, divideByTwo, fullAdder, inverterRing, random, randomCircuit, srLatch } from "./fixtures";

/** Runs a sequence of steps in sequential mode, passing each step's state to the next. */
function steps(circuit: Circuit, sequence: Record<string, Bit>[]): SequentialResult[] {
  const prepared = sequential.prepare(circuit);
  const results: SequentialResult[] = [];
  let state: SimulationState | undefined;
  for (const inputs of sequence) {
    const result = prepared.run(inputs, state);
    if (result.mode !== "sequential") throw new Error("expected a sequential result");
    results.push(result);
    state = result.state;
  }
  return results;
}

const outputsOf = (results: SequentialResult[], output: string): (Bit | undefined)[] => results.map((result) => result.outputs[output]);

describe("the strategy registry", () => {
  it("has a strategy for every mode, each used the same way", () => {
    expect(SIMULATION_MODES).toEqual(["combinational", "sequential"]);
    for (const mode of SIMULATION_MODES) {
      const prepared = simulationStrategy(mode).prepare(fullAdder());
      expect(prepared.mode).toBe(mode);
      expect(prepared.run({ A: 1, B: 1, Cin: 0 }).outputs).toEqual({ S: 0, Cout: 1 });
    }
    expect(() => simulationStrategy("quantum" as never)).toThrow(RangeError);
  });

  it("lets only the sequential strategy take circuits with feedback loops", () => {
    expect(() => combinational.prepare(srLatch())).toThrow(CycleError);
    expect(sequential.prepare(srLatch()).stateIds).toEqual(["q", "qbar"]);
  });

  it("gives the same answer in both modes for 200 random circuits without loops", () => {
    const next = random(9);
    for (let n = 0; n < 200; n++) {
      const circuit = randomCircuit(next, 1 + Math.floor(next() * 5), 1 + Math.floor(next() * 40));
      const inputs = Object.fromEntries(circuit.gates.filter((gate) => gate.type === "INPUT").map((gate): [string, Bit] => [gate.id, next() < 0.5 ? 0 : 1]));
      const once = combinational.prepare(circuit).run(inputs);
      const stepped = sequential.prepare(circuit).run(inputs);
      expect(stepped.signals).toEqual(once.signals);
      // Without loops nothing is remembered, and every gate is evaluated exactly once.
      expect(stepped.mode === "sequential" && [stepped.state, stepped.evaluations]).toEqual([{}, circuit.gates.length]);
    }
  });
});

describe("sequential simulation", () => {
  it("remembers: an SR latch is set, holds, is reset, and holds again", () => {
    const results = steps(srLatch(), [
      { S: 1, R: 0 }, // set
      { S: 0, R: 0 }, // hold
      { S: 0, R: 1 }, // reset
      { S: 0, R: 0 }, // hold
    ]);
    expect(outputsOf(results, "Q")).toEqual([1, 1, 0, 0]);
    expect(results.map((result) => result.state)).toEqual([
      { q: 1, qbar: 0 },
      { q: 1, qbar: 0 },
      { q: 0, qbar: 1 },
      { q: 0, qbar: 1 },
    ]);
  });

  it("the same inputs give different outputs depending on the state: that is memory", () => {
    const latch = sequential.prepare(srLatch());
    expect(latch.run({ S: 0, R: 0 }, { q: 1, qbar: 0 }).outputs.Q).toBe(1);
    expect(latch.run({ S: 0, R: 0 }, { q: 0, qbar: 1 }).outputs.Q).toBe(0);
  });

  it("a gated D latch follows D while enabled, and holds it while not", () => {
    const results = steps(dLatch(), [
      { D: 1, E: 1 },
      { D: 0, E: 0 }, // disabled: keeps the 1
      { D: 0, E: 1 }, // enabled: follows to 0
      { D: 1, E: 0 }, // keeps the 0
    ]);
    expect(outputsOf(results, "Q")).toEqual([1, 1, 0, 0]);
  });

  it("a master-slave flip-flop changes only when the clock rises", () => {
    const results = steps(dFlipFlop(), [
      // Like real hardware, a flip-flop holds nothing meaningful at power-up (here every gate starts
      // at 0, which a NAND latch can't hold, so it resolves to 0 or 1). Clocking in a 0 defines Q.
      { D: 0, CLK: 0 },
      { D: 0, CLK: 1 }, // rising edge: Q takes D = 0
      { D: 1, CLK: 1 }, // D changes while the clock is high: ignored
      { D: 1, CLK: 0 }, // falling edge: ignored
      { D: 1, CLK: 1 }, // rising edge: Q takes D = 1
      { D: 0, CLK: 1 }, // ignored
      { D: 0, CLK: 0 }, // ignored
      { D: 0, CLK: 1 }, // rising edge: Q takes D = 0
    ]);
    expect(outputsOf(results, "Q").slice(1)).toEqual([0, 0, 0, 1, 1, 1, 0]);
  });

  it("a flip-flop fed its inverted output divides the clock by two", () => {
    const clock: Record<string, Bit>[] = Array.from({ length: 12 }, (_, k) => ({ CLK: (k % 2) as Bit }));
    const q = outputsOf(steps(divideByTwo(), clock), "Q");
    // Q flips on every rising edge (odd steps) and holds on every falling one: half the frequency.
    for (let k = 1; k < q.length; k++) expect(q[k] !== q[k - 1], `step ${k}`).toBe(k % 2 === 1);
  });

  it("reports a loop that never settles: an odd ring of inverters oscillates", () => {
    for (const ring of [inverterRing(1), inverterRing(3)]) {
      const error = (() => {
        try {
          sequential.prepare(ring).run({});
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      expect(error).toBeInstanceOf(OscillationError);
      expect((error as OscillationError).gates).toEqual(ring.gates.filter((gate) => gate.type === "NOT").map((gate) => gate.id));
    }
  });

  it("settles an even ring: two inverters are a latch", () => {
    expect(sequential.prepare(inverterRing(2)).run({})).toMatchObject({ state: { n0: 1, n1: 0 } });
  });

  it("gives each loop a budget of evaluations, which can be set", () => {
    // Setting a reset latch takes 4 evaluations (q, qbar, q, qbar); a budget of 1 per gate allows 2.
    const strict = sequentialStrategy({ maxEvaluationsPerGate: 1 }).prepare(srLatch());
    expect(() => strict.run({ S: 1, R: 0 }, { q: 0, qbar: 1 })).toThrow(OscillationError);
    // 7 evaluations: S, R, and the output once each, and the loop's 4.
    expect(sequential.prepare(srLatch()).run({ S: 1, R: 0 }, { q: 0, qbar: 1 })).toMatchObject({ outputs: { Q: 1 }, evaluations: 7 });
  });

  it("is reproducible where hardware would race: releasing S = R = 1 at once", () => {
    const results = steps(srLatch(), [{ S: 1, R: 1 }, { S: 0, R: 0 }]);
    expect(results[0]?.state).toEqual({ q: 0, qbar: 0 });
    expect(results[1]?.state).toEqual({ q: 1, qbar: 0 }); // q is declared first, so it moves first
  });

  it("checks the state: only gates on loops, only 0 or 1, reported together with input problems", () => {
    const latch = sequential.prepare(srLatch());
    const issues = (() => {
      try {
        latch.run({ S: 2 } as never, { q: 1, S: 0, qbar: "1" } as never);
      } catch (error) {
        if (error instanceof SimulationInputError) return error.issues.map(({ code, inputId, stateGateId }) => ({ code, ...(inputId && { inputId }), ...(stateGateId && { stateGateId }) }));
      }
      return [];
    })();
    expect(issues).toEqual([
      { code: "INVALID_INPUT_VALUE", inputId: "S" },
      { code: "MISSING_INPUT", inputId: "R" },
      { code: "UNKNOWN_STATE_GATE", stateGateId: "S" },
      { code: "INVALID_STATE_VALUE", stateGateId: "qbar" },
    ]);
    expect(() => latch.run({ S: 0, R: 0 }, [] as never)).toThrow(SimulationInputError);
  });

  it("treats a circuit without loops as having no state at all, in either mode", () => {
    expect(() => combinational.prepare(fullAdder()).run({ A: 0, B: 0, Cin: 0 }, { S: 1 })).toThrow(/holds no state/);
    expect(() => sequential.prepare(fullAdder()).run({ A: 0, B: 0, Cin: 0 }, { S: 1 })).toThrow(/it has no feedback loops/);
  });
});
