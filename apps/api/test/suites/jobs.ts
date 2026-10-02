import { LIMITS } from "@circuitlab/api-contract";
import { describe, expect, it } from "vitest";
import { adderBody, createCircuit, finishedJob, register, type TestContext } from "../support/server";

const jobs = (id: string): string => `/v1/circuits/${id}/truth-table/jobs`;

export function jobsSuite(context: () => TestContext): void {
  describe("truth-table jobs", () => {
    it("computes a table in the background: 202 and a Location to poll, then the rows to download", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada, adderBody(4)); // 8 inputs: 256 rows
      const started = await api.post(jobs(id), { as: ada, json: {} });
      expect(started.status, started.text).toBe(202);
      expect(started.headers.get("location")).toBe(started.body.links.self);
      expect(started.headers.get("retry-after")).toBe(String(LIMITS.retryAfterSeconds.jobPoll));
      expect(started.body).toMatchObject({ circuitId: id, circuitVersion: 1, status: "queued", offset: 0, limit: 256, rowsDone: 0 });

      const done = await finishedJob(api, ada, started.body.links.self);
      expect(done).toMatchObject({ status: "succeeded", rowsDone: 256, links: { result: `${started.body.links.self}/result` } });
      expect(Date.parse(done.expiresAt) - Date.parse(done.finishedAt)).toBe(LIMITS.truthTableJobs.resultHours * 3_600_000);
      expect(Date.parse(done.startedAt)).toBeGreaterThanOrEqual(Date.parse(done.createdAt));

      // The rows are exactly what the synchronous download gives, in either format.
      for (const [accept, extension] of [["text/csv", "csv"], ["application/x-ndjson", "ndjson"]] as const) {
        const fromJob = await api.get(done.links.result, { as: ada, headers: { Accept: accept } });
        const direct = await api.get(`/v1/circuits/${id}/truth-table`, { as: ada, headers: { Accept: accept } });
        expect(fromJob.status).toBe(200);
        expect(fromJob.headers.get("content-type")).toBe(direct.headers.get("content-type"));
        expect(fromJob.headers.get("content-disposition")).toBe(`attachment; filename="truth-table-${done.id}.${extension}"`);
        expect(fromJob.text).toBe(direct.text);
      }
    });

    it("computes a range of rows, cut at the end of the table", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada, adderBody(4));
      const started = await api.post(jobs(id), { as: ada, json: { offset: 100, limit: 1000, version: 1 } });
      expect(started.body).toMatchObject({ offset: 100, limit: 156 });
      const done = await finishedJob(api, ada, started.body.links.self);
      const fromJob = await api.get(done.links.result, { as: ada });
      const direct = await api.get(`/v1/circuits/${id}/truth-table?offset=100&limit=156`, { as: ada, headers: { Accept: "text/csv" } });
      expect(fromJob.text).toBe(direct.text);
      expect(fromJob.text.trim().split("\r\n")).toHaveLength(157); // the header and 156 rows
    });

    it("lists jobs in the circuit's run history", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      const started = await api.post(jobs(id), { as: ada, json: { offset: 1 } });
      await finishedJob(api, ada, started.body.links.self);
      const runs = await api.get(`/v1/circuits/${id}/runs`, { as: ada });
      expect(runs.body.items).toEqual([
        expect.objectContaining({ id: started.body.id, kind: "truth_table", mode: "combinational", status: "succeeded", offset: 1, limit: 3, circuitVersion: 1 }),
      ]);
    });

    it("refuses jobs that can't be done, before queueing anything", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const small = await createCircuit(api, ada);
      const huge = await createCircuit(api, ada, adderBody(13)); // 26 inputs: 67,108,864 rows
      const loop = await createCircuit(api, ada, {
        name: "loop",
        gates: [{ id: "A", type: "INPUT" }, { id: "q", type: "OR" }, { id: "Q", type: "OUTPUT" }],
        wires: [{ from: "A", to: "q", toPin: 0 }, { from: "q", to: "q", toPin: 1 }, { from: "q", to: "Q", toPin: 0 }],
      });

      const tooBig = await api.post(jobs(huge), { as: ada, json: {} });
      expect([tooBig.status, tooBig.body.code]).toEqual([422, "computation-too-large"]);
      // Over all three limits: rows, gate evaluations (103 gates), and the result's size (14 outputs).
      expect(tooBig.body.issues.map((issue: { code: string; pointer: string }) => `${issue.code} ${issue.pointer}`)).toEqual(Array(3).fill("JOB_TOO_LARGE /limit"));
      expect(tooBig.body.detail).toBe("This job is too large. For this circuit, one job can cover at most 9,586,980 rows: split the table with offset and limit.");
      // The same circuit, a piece at a time, is fine.
      const piece = await api.post(jobs(huge), { as: ada, json: { offset: 2 ** 25, limit: 1000 } });
      expect(piece.status).toBe(202);
      await finishedJob(api, ada, piece.body.links.self);

      const pastEnd = await api.post(jobs(small), { as: ada, json: { offset: 4 } });
      expect([pastEnd.status, pastEnd.body.code, pastEnd.body.issues[0].pointer]).toEqual([422, "invalid-fields", "/offset"]);
      const loopy = await api.post(jobs(loop), { as: ada, json: {} });
      expect([loopy.status, loopy.body.code]).toEqual([422, "feedback-loop"]);
      const stale = await api.post(jobs(small), { as: ada, json: { version: 2 } });
      expect([stale.status, stale.body.code]).toEqual([409, "version-conflict"]);
      const unknownField = await api.post(jobs(small), { as: ada, json: { rows: 5 } });
      expect([unknownField.status, unknownField.body.code]).toEqual([422, "invalid-fields"]);
      expect((await api.post(jobs(small), { as: ada, json: [] })).status).toBe(400);
      expect((await api.post(jobs(small), { as: ada, body: "{}", headers: { "Content-Type": "text/plain" } })).status).toBe(415);
    });

    it("are for signed-in people who can read the circuit, and each job is seen only by whoever started it", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const bob = await register(api, "Bob");
      const eve = await register(api, "Eve");
      const id = await createCircuit(api, ada);

      const signedOut = await api.post(jobs(id), { json: {} });
      expect([signedOut.status, signedOut.headers.get("www-authenticate")]).toEqual([401, 'Bearer realm="circuitlab"']);
      expect((await api.post(jobs(id), { as: eve, json: {} })).status).toBe(404); // she can't see the circuit

      await api.post(`/v1/circuits/${id}/shares`, { as: ada, json: { email: bob.email, role: "viewer" } });
      const bobs = await api.post(jobs(id), { as: bob, json: {} }); // reading is enough
      expect(bobs.status).toBe(202);
      await finishedJob(api, bob, bobs.body.links.self);
      expect((await api.get(bobs.body.links.self, { as: ada })).status).toBe(404); // not even the owner sees Bob's job
      expect((await api.get(`${bobs.body.links.self}/result`, { as: eve })).status).toBe(404);
      expect((await api.delete(bobs.body.links.self, { as: ada })).status).toBe(404);

      // Losing access to the circuit means losing access to its jobs.
      await api.delete(`/v1/circuits/${id}/shares/${bob.id}`, { as: ada });
      expect((await api.get(bobs.body.links.self, { as: bob })).status).toBe(404);
      expect((await api.get(`${jobs(id)}/not-a-job`, { as: ada })).status).toBe(404);
    });

    it("deletes a finished job's result; the job stays, without it (410 for the download)", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      const started = await api.post(jobs(id), { as: ada, json: {} });
      await finishedJob(api, ada, started.body.links.self);
      expect((await api.delete(started.body.links.self, { as: ada })).status).toBe(204);
      expect((await api.delete(started.body.links.self, { as: ada })).status).toBe(204); // again: still fine

      const job = await api.get(started.body.links.self, { as: ada });
      expect(job.body.status).toBe("succeeded");
      expect(job.body.links.result).toBeUndefined();
      const gone = await api.get(`${started.body.links.self}/result`, { as: ada });
      expect([gone.status, gone.body.code]).toEqual([410, "result-gone"]);
    });

    it("cancels a running job: it stops, keeps no result, and says it was cancelled", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada, adderBody(10)); // 1,048,576 rows: a second or two of work
      const started = await api.post(jobs(id), { as: ada, json: {} });
      expect((await api.delete(started.body.links.self, { as: ada })).status).toBe(204);
      const job = await finishedJob(api, ada, started.body.links.self);
      expect(job.status).toBe("cancelled");
      expect(job.rowsDone).toBeLessThan(job.limit);
      const result = await api.get(`${started.body.links.self}/result`, { as: ada });
      expect([result.status, result.body.code, result.body.detail]).toEqual([409, "job-failed", "The job was cancelled, so it has no result. Start a new job."]);
    });

    it("goes when its circuit is deleted", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const id = await createCircuit(api, ada);
      const started = await api.post(jobs(id), { as: ada, json: {} });
      await finishedJob(api, ada, started.body.links.self);
      await api.delete(`/v1/circuits/${id}`, { as: ada });
      expect((await api.get(started.body.links.self, { as: ada })).status).toBe(404);
    });
  });
}
