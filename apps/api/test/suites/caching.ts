import { describe, expect, it } from "vitest";
import { createCircuit, halfAdderBody, register, type TestContext } from "../support/server";

const HIT = "CircuitLab; hit";
const STORED = "CircuitLab; fwd=miss; stored";

/** An SR latch from two NOR gates: what it outputs depends on what it remembers. */
const latchBody = {
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

export function cachingSuite(context: () => TestContext): void {
  describe("the result cache", () => {
    it("answers a repeated simulation from the cache, whatever order the inputs come in", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      const simulate = (inputs: Record<string, number>, query = "") => api.post(`/v1/circuits/${id}/simulate${query}`, { as: ada, json: { inputs } });

      const first = await simulate({ A: 1, B: 0 });
      expect([first.status, first.headers.get("cache-status")]).toEqual([200, STORED]);
      const again = await simulate({ B: 0, A: 1 });
      expect([again.headers.get("cache-status"), again.body]).toEqual([HIT, first.body]);
      // The whole result is kept, so a hit can still show every signal and the evaluation order.
      const detailed = await simulate({ A: 1, B: 0 }, "?include=signals");
      expect(detailed.headers.get("cache-status")).toBe(HIT);
      expect(detailed.body).toMatchObject({ signals: { A: 1, B: 0, sum: 1, carry: 0, S: 1, C: 0 }, order: ["A", "B", "sum", "carry", "S", "C"] });
      expect((await simulate({ A: 1, B: 1 })).headers.get("cache-status")).toBe(STORED);
    });

    it("never answers from an old version: every change to a circuit makes new keys", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      const simulate = () => api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A: 1, B: 1 } } });
      expect((await simulate()).body.outputs).toEqual({ S: 0, C: 1 });
      expect((await simulate()).headers.get("cache-status")).toBe(HIT);

      // The carry gate becomes a NAND, so the same inputs now give C = 0...
      const changed = halfAdderBody();
      changed.gates[3] = { id: "carry", type: "NAND" };
      await api.put(`/v1/circuits/${id}`, { as: ada, json: changed });
      const afterEdit = await simulate();
      expect([afterEdit.headers.get("cache-status"), afterEdit.body.circuitVersion, afterEdit.body.outputs]).toEqual([STORED, 2, { S: 0, C: 0 }]);
      // ...and even a rename is a new version.
      await api.patch(`/v1/circuits/${id}`, { as: ada, body: JSON.stringify({ name: "Renamed" }), headers: { "Content-Type": "application/merge-patch+json" } });
      expect((await simulate()).headers.get("cache-status")).toBe(STORED);
    });

    it("checks who is asking before looking in the cache", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const eve = await register(api, "Eve");
      const id = await createCircuit(api, ada);
      await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A: 0, B: 1 } } });
      expect((await api.post(`/v1/circuits/${id}/simulate`, { as: eve, json: { inputs: { A: 0, B: 1 } } })).status).toBe(404);
      expect((await api.post(`/v1/circuits/${id}/simulate`, { json: { inputs: { A: 0, B: 1 } } })).status).toBe(404);
    });

    it("records an answer from the cache in the run history like any other", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      for (let n = 0; n < 2; n++) await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A: 1, B: 1 } } });
      const runs = await api.get(`/v1/circuits/${id}/runs`, { as: ada });
      expect(runs.body.items.map((run: { status: string; outputs: unknown }) => [run.status, run.outputs])).toEqual([
        ["succeeded", { S: 0, C: 1 }],
        ["succeeded", { S: 0, C: 1 }],
      ]);
    });

    it("keeps only successes: a refusal is worked out again", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      for (let n = 0; n < 2; n++) {
        const reply = await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A: 1 } } });
        expect([reply.status, reply.headers.get("cache-status")]).toEqual([422, null]);
      }
    });

    it("keeps sequential steps apart by the state they start from", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada, latchBody);
      const step = (state: Record<string, number>) => api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { S: 0, R: 0 }, mode: "sequential", state } });
      const set = await step({ q: 1, qbar: 0 });
      const reset = await step({ q: 0, qbar: 1 });
      expect([set.headers.get("cache-status"), set.body.outputs, reset.headers.get("cache-status"), reset.body.outputs]).toEqual([STORED, { Q: 1 }, STORED, { Q: 0 }]);
      const setAgain = await step({ qbar: 0, q: 1 });
      expect([setAgain.headers.get("cache-status"), setAgain.body.state]).toEqual([HIT, { q: 1, qbar: 0 }]);
    });

    it("caches truth-table pages, and answers a current copy with 304 without touching the cache", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      const first = await api.get(`/v1/circuits/${id}/truth-table?limit=2`, { as: ada });
      expect([first.status, first.headers.get("cache-status")]).toEqual([200, STORED]);
      const again = await api.get(`/v1/circuits/${id}/truth-table?limit=2`, { as: ada });
      expect([again.headers.get("cache-status"), again.body, again.headers.get("etag")]).toEqual([HIT, first.body, first.headers.get("etag")]);
      const current = await api.get(`/v1/circuits/${id}/truth-table?limit=2`, { as: ada, headers: { "If-None-Match": first.headers.get("etag") ?? "" } });
      expect([current.status, current.headers.get("cache-status")]).toEqual([304, null]);
      expect((await api.get(`/v1/circuits/${id}/truth-table?offset=2&limit=2`, { as: ada })).headers.get("cache-status")).toBe(STORED);
      // Downloads are streamed, not cached.
      const csv = await api.get(`/v1/circuits/${id}/truth-table`, { as: ada, headers: { Accept: "text/csv" } });
      expect([csv.status, csv.headers.get("cache-status")]).toEqual([200, null]);
    });
  });
}
