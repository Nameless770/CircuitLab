import { describe, expect, it } from "vitest";
import type { Api, Person } from "../support/client";
import { createCircuit, register, type TestContext } from "../support/server";

/** Two cross-coupled NOR gates: a latch. */
const SR_LATCH = {
  name: "SR latch",
  gates: [
    { id: "S", type: "INPUT" },
    { id: "R", type: "INPUT" },
    { id: "q", type: "NOR" },
    { id: "qbar", type: "NOR" },
    { id: "Q", type: "OUTPUT" },
  ],
  wires: [
    { from: "R", to: "q", toPin: 0 },
    { from: "qbar", to: "q", toPin: 1 },
    { from: "S", to: "qbar", toPin: 0 },
    { from: "q", to: "qbar", toPin: 1 },
    { from: "q", to: "Q", toPin: 0 },
  ],
};

/** Three inverters in a ring: never settles. */
const RING = {
  name: "Ring oscillator",
  gates: [{ id: "a", type: "NOT" }, { id: "b", type: "NOT" }, { id: "c", type: "NOT" }, { id: "Y", type: "OUTPUT" }],
  wires: [
    { from: "c", to: "a", toPin: 0 },
    { from: "a", to: "b", toPin: 0 },
    { from: "b", to: "c", toPin: 0 },
    { from: "a", to: "Y", toPin: 0 },
  ],
};

async function step(api: Api, as: Person, id: string, inputs: Record<string, number>, state?: unknown) {
  const reply = await api.post(`/v1/circuits/${id}/simulate`, { as, json: { inputs, mode: "sequential", ...(state !== undefined && { state }) } });
  expect(reply.status, reply.text).toBe(200);
  return reply.body;
}

export function sequentialSuite(context: () => TestContext): void {
  describe("sequential simulation", () => {
    it("runs a latch step by step, the client carrying its state from one step to the next", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada, SR_LATCH);
      const set = await step(api, ada, id, { S: 1, R: 0 });
      expect(set).toMatchObject({ mode: "sequential", outputs: { Q: 1 }, state: { q: 1, qbar: 0 } });
      const hold = await step(api, ada, id, { S: 0, R: 0 }, set.state);
      const reset = await step(api, ada, id, { S: 0, R: 1 }, hold.state);
      const holdAgain = await step(api, ada, id, { S: 0, R: 0 }, reset.state);
      expect([set, hold, reset, holdAgain].map((answer) => answer.outputs.Q)).toEqual([1, 1, 0, 0]);
    });

    it("returns every signal on request, but no evaluation order: loops have none", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada, SR_LATCH);
      const reply = await api.post(`/v1/circuits/${id}/simulate?include=signals`, { as: ada, json: { inputs: { S: 1, R: 0 }, mode: "sequential" } });
      expect(reply.body.signals).toEqual({ S: 1, R: 0, q: 1, qbar: 0, Q: 1 });
      expect(reply.body.order).toBeUndefined();
    });

    it("still refuses a loop in combinational mode, the default", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada, SR_LATCH);
      const reply = await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { S: 1, R: 0 } } });
      expect([reply.status, reply.body.code]).toEqual([422, "feedback-loop"]);
    });

    it("answers 422 does-not-settle for a loop that oscillates, naming its gates", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada, RING);
      const reply = await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: {}, mode: "sequential" } });
      expect([reply.status, reply.body.code]).toEqual([422, "does-not-settle"]);
      expect(reply.body.issues.map((issue: { gateId: string }) => issue.gateId)).toEqual(["a", "b", "c"]);
    });

    it("checks the state like the inputs, pointing at each problem", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada, SR_LATCH);
      const reply = await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { S: 0, R: 0 }, mode: "sequential", state: { q: 2, S: 1 } } });
      expect(reply.status).toBe(422);
      expect(reply.body.issues.map((issue: { code: string; pointer: string }) => `${issue.code}@${issue.pointer}`)).toEqual([
        "INVALID_STATE_VALUE@/state/q",
        "UNKNOWN_STATE_GATE@/state/S",
      ]);
      const unknownMode = await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { S: 0, R: 0 }, mode: "quantum" } });
      expect([unknownMode.status, unknownMode.body.issues?.[0]?.pointer]).toEqual([422, "/mode"]);
    });

    it("records each run's mode in the history", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada, {
        name: "buffer",
        gates: [{ id: "A", type: "INPUT" }, { id: "Y", type: "OUTPUT" }],
        wires: [{ from: "A", to: "Y", toPin: 0 }],
      });
      await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A: 1 } } });
      await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A: 0 }, mode: "sequential" } });
      const runs = (await api.get(`/v1/circuits/${id}/runs`, { as: ada })).body.items;
      expect(runs.map((run: { mode: string }) => run.mode)).toEqual(["sequential", "combinational"]);
    });
  });
}
