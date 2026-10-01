import { describe, expect, it } from "vitest";
import { createCircuit, register, type TestContext } from "../support/server";

export function simulationSuite(context: () => TestContext): void {
  describe("simulating", () => {
    it("returns the outputs, and on request every gate's signal and the evaluation order", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      const plain = await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A: 1, B: 1 } } });
      expect(plain.body).toEqual({ circuitId: id, circuitVersion: 1, mode: "combinational", outputs: { S: 0, C: 1 } });
      const detailed = await api.post(`/v1/circuits/${id}/simulate?include=signals`, { as: ada, json: { inputs: { A: 1, B: 0 } } });
      expect(detailed.body).toMatchObject({ signals: { A: 1, B: 0, sum: 1, carry: 0, S: 1, C: 0 }, order: ["A", "B", "sum", "carry", "S", "C"] });
    });

    it("reports every input problem at once, each at its pointer", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      const reply = await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A: "1", Cin: 0 } } });
      expect(reply.status).toBe(422);
      expect(reply.body.issues.map((issue: { pointer: string }) => issue.pointer)).toEqual(["/inputs/A", "/inputs/B", "/inputs/Cin"]);
    });

    it("explains why a circuit with a feedback loop can't be simulated", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const latch = { name: "loop", gates: [{ id: "A", type: "INPUT" }, { id: "q", type: "OR" }, { id: "Q", type: "OUTPUT" }], wires: [{ from: "A", to: "q", toPin: 0 }, { from: "q", to: "q", toPin: 1 }, { from: "q", to: "Q", toPin: 0 }] };
      const id = await createCircuit(api, ada, latch);
      const reply = await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A: 1 } } });
      expect([reply.status, reply.body.code, reply.body.cycle]).toEqual([422, "feedback-loop", ["q", "q"]]);
    });

    it("refuses a body that isn't JSON (415)", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      const reply = await api.post(`/v1/circuits/${id}/simulate`, { as: ada, body: "A=1", headers: { "Content-Type": "text/plain" } });
      expect(reply.status).toBe(415);
    });
  });

  describe("truth tables", () => {
    it("pages through rows, with links pinned to the circuit's version", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      const page = await api.get(`/v1/circuits/${id}/truth-table?offset=1&limit=2`, { as: ada });
      expect(page.body).toMatchObject({ totalRows: 4, offset: 1, limit: 2, inputs: ["A", "B"], outputs: ["S", "C"] });
      expect(page.body.rows).toEqual([
        { index: 1, inputs: [0, 1], outputs: [1, 0] },
        { index: 2, inputs: [1, 0], outputs: [1, 0] },
      ]);
      expect(page.body.links.next).toBe(`/v1/circuits/${id}/truth-table?offset=3&limit=2&version=1`);
      const etag = page.headers.get("etag") ?? "";
      expect((await api.get(`/v1/circuits/${id}/truth-table?offset=1&limit=2`, { as: ada, headers: { "If-None-Match": etag } })).status).toBe(304);
    });

    it("answers 409 when the circuit changed since the first page", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      await api.patch(`/v1/circuits/${id}`, { as: ada, json: { name: "changed" } });
      const reply = await api.get(`/v1/circuits/${id}/truth-table?version=1`, { as: ada });
      expect([reply.status, reply.body.code]).toEqual([409, "version-conflict"]);
    });

    it("downloads as CSV or NDJSON", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      const csv = await api.get(`/v1/circuits/${id}/truth-table`, { as: ada, headers: { Accept: "text/csv" } });
      expect(csv.text).toBe("#,A,B,S,C\r\n0,0,0,0,0\r\n1,0,1,1,0\r\n2,1,0,1,0\r\n3,1,1,0,1\r\n");
      const ndjson = await api.get(`/v1/circuits/${id}/truth-table?offset=3`, { as: ada, headers: { Accept: "application/x-ndjson" } });
      expect(ndjson.text.trim().split("\n").map((line) => JSON.parse(line))).toEqual([{ index: 3, inputs: { A: 1, B: 1 }, outputs: { S: 0, C: 1 } }]);
    });
  });

  describe("simulation history", () => {
    it("records every simulation, failed ones with their problem code, keeping only the circuit's own inputs", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A: 1, B: 0 } } });
      await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A: 1, Junk: 1 } } });
      const runs = (await api.get(`/v1/circuits/${id}/runs`, { as: ada })).body.items;
      expect(runs.map((run: { status: string }) => run.status)).toEqual(["failed", "succeeded"]); // newest first
      expect(runs[0]).toMatchObject({ errorCode: "invalid-inputs", inputs: { A: 1 }, circuitVersion: 1 });
      expect(runs[1]).toMatchObject({ outputs: { S: 1, C: 0 }, inputs: { A: 1, B: 0 } });
      expect((await api.get(`/v1/circuits/${id}/runs?limit=1`, { as: ada })).body.items).toHaveLength(1);
    });

    it("shows the owner everyone's runs, and anyone else only their own", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const bob = await register(api, "Bob");
      const id = await createCircuit(api, ada);
      await api.patch(`/v1/circuits/${id}`, { as: ada, json: { visibility: "public" } });
      await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A: 0, B: 0 } } });
      await api.post(`/v1/circuits/${id}/simulate`, { as: bob, json: { inputs: { A: 1, B: 1 } } });
      await api.post(`/v1/circuits/${id}/simulate`, { json: { inputs: { A: 0, B: 1 } } }); // signed out
      const inputsSeenBy = async (as: typeof ada): Promise<unknown[]> => (await api.get(`/v1/circuits/${id}/runs`, { as })).body.items.map((run: { inputs: unknown }) => run.inputs);
      expect(await inputsSeenBy(ada)).toEqual([{ A: 0, B: 1 }, { A: 1, B: 1 }, { A: 0, B: 0 }]);
      expect(await inputsSeenBy(bob)).toEqual([{ A: 1, B: 1 }]);
    });
  });
}
