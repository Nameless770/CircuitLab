import {
  LIMITS,
  jobFailed,
  jobRange,
  jobResource,
  jobUnfinished,
  parseTruthTableJobRequest,
  resultGone,
  toProblem,
  tooManyJobs,
  type CircuitSummary,
  type JobRecord,
} from "@circuitlab/api-contract";
import { describe, expect, it } from "vitest";
import { expectConforms, issuesAt, problemOf } from "./helpers";

const summary = (inputs: number, gates: number, outputs: number): CircuitSummary => ({
  gates,
  wires: 0,
  inputs: Array.from({ length: inputs }, (_, k) => `I${k}`),
  outputs: Array.from({ length: outputs }, (_, k) => `O${k}`),
  feedbackLoop: null,
});

const job = (overrides: Partial<JobRecord> = {}): JobRecord => ({
  id: "j1",
  circuitId: "c1",
  circuitVersion: 2,
  userId: "u1",
  status: "succeeded",
  offset: 0,
  limit: 16,
  errorCode: null,
  createdAt: new Date("2026-10-01T10:00:00Z"),
  startedAt: new Date("2026-10-01T10:00:01Z"),
  finishedAt: new Date("2026-10-01T10:00:02Z"),
  ...overrides,
});

describe("truth-table jobs in the contract", () => {
  it("reads a job request: the whole table by default", () => {
    expect(parseTruthTableJobRequest({})).toEqual({ offset: 0 });
    expect(parseTruthTableJobRequest({ offset: 8, limit: 4, version: 3 })).toEqual({ offset: 8, limit: 4, version: 3 });
    expect(issuesAt(problemOf(() => parseTruthTableJobRequest({ offset: -1, limit: 0, rows: 3 })))).toEqual([
      "UNKNOWN_FIELD@/rows",
      "OUT_OF_RANGE@/offset",
      "OUT_OF_RANGE@/limit",
    ]);
    expect(problemOf(() => parseTruthTableJobRequest("all")).body.code).toBe("malformed-body");
  });

  it("covers the rest of the table unless told otherwise, and never runs past its end", () => {
    expect(jobRange({ offset: 0 }, summary(4, 10, 1))).toEqual({ offset: 0, limit: 16 });
    expect(jobRange({ offset: 10 }, summary(4, 10, 1))).toEqual({ offset: 10, limit: 6 });
    expect(jobRange({ offset: 10, limit: 100 }, summary(4, 10, 1))).toEqual({ offset: 10, limit: 6 });
    expect(jobRange({ offset: 10, limit: 2 }, summary(4, 10, 1))).toEqual({ offset: 10, limit: 2 });
    const pastEnd = problemOf(() => jobRange({ offset: 16 }, summary(4, 10, 1)));
    expect([pastEnd.status, pastEnd.body.code, issuesAt(pastEnd)]).toEqual([422, "invalid-fields", ["OFFSET_PAST_END@/offset"]]);
  });

  it("holds each job to three limits: rows, work, and the size of the result", () => {
    const { maxRows, maxGateEvaluations, maxResultBits } = LIMITS.truthTableJobs;
    // Exactly at each limit is fine.
    expect(jobRange({ offset: 0, limit: maxRows }, summary(30, 16, 1)).limit).toBe(maxRows);
    expect(jobRange({ offset: 0, limit: maxGateEvaluations / 1024 }, summary(30, 1024, 8)).limit).toBe(maxGateEvaluations / 1024);
    expect(jobRange({ offset: 0, limit: maxResultBits / 64 }, summary(30, 64, 64)).limit).toBe(maxResultBits / 64);
    // One row more is not.
    const rows = problemOf(() => jobRange({ offset: 0, limit: maxRows + 1 }, summary(30, 16, 1)));
    const work = problemOf(() => jobRange({ offset: 0, limit: maxGateEvaluations / 1024 + 1 }, summary(30, 1024, 8)));
    const size = problemOf(() => jobRange({ offset: 0, limit: maxResultBits / 64 + 1 }, summary(30, 64, 64)));
    for (const problem of [rows, work, size]) expect([problem.status, problem.body.code, issuesAt(problem)]).toEqual([422, "computation-too-large", ["JOB_TOO_LARGE@/limit"]]);
    expect(rows.body.detail).toBe("This job is too large. For this circuit, one job can cover at most 16,777,216 rows: split the table with offset and limit.");
    expect(work.body.detail).toMatch(/at most 2,097,152 rows/);
    expect(size.body.detail).toMatch(/at most 2,097,152 rows/);
    expect(work.body.issues?.[0]?.message).toBe("a job may evaluate at most 2,147,483,648 gates in all; 2,097,153 rows of 1,024 gates is 2,147,484,672");
  });

  it("shows a job, with its result's link only while the result can be downloaded", () => {
    const shown = jobResource(job(), { rowsDone: 0, downloadable: true, basePath: "/v1" });
    expectConforms("TruthTableJob", shown);
    expect(shown).toMatchObject({
      rowsDone: 16,
      expiresAt: "2026-10-02T10:00:02.000Z",
      links: { self: "/v1/circuits/c1/truth-table/jobs/j1", circuit: "/v1/circuits/c1", result: "/v1/circuits/c1/truth-table/jobs/j1/result" },
    });
    expect(jobResource(job(), { rowsDone: 0, downloadable: false, basePath: "/v1" }).links.result).toBeUndefined();

    const running = jobResource(job({ status: "running", finishedAt: null }), { rowsDone: 99, downloadable: true, basePath: "/v1" });
    expectConforms("TruthTableJob", running);
    expect([running.rowsDone, running.expiresAt, running.links.result, running.finishedAt]).toEqual([16, undefined, undefined, undefined]);
    const failed = jobResource(job({ status: "failed", errorCode: "version-conflict" }), { rowsDone: 0, downloadable: true, basePath: "/v1" });
    expectConforms("TruthTableJob", failed);
    expect([failed.errorCode, failed.expiresAt, failed.links.result]).toEqual(["version-conflict", undefined, undefined]);
  });

  it("explains why there is no result", () => {
    const unfinished = toProblem(jobUnfinished("running"));
    expect([unfinished.status, unfinished.body.code, unfinished.headers["Retry-After"]]).toEqual([409, "job-unfinished", "2"]);
    expect(toProblem(jobFailed({ status: "failed", errorCode: "simulation-timeout" })).body.detail).toBe(
      "The job failed (simulation-timeout), so it has no result. Start a new job.",
    );
    expect(toProblem(jobFailed({ status: "cancelled", errorCode: null })).body).toMatchObject({ status: 409, code: "job-failed", detail: "The job was cancelled, so it has no result. Start a new job." });
    expect(toProblem(resultGone())).toMatchObject({ status: 410, body: { code: "result-gone", title: "Result no longer available" } });
  });

  it("says when another job may start", () => {
    const active = toProblem(tooManyJobs("active", 2));
    const daily = toProblem(tooManyJobs("daily", 85_799.2));
    expect([active.status, active.body.code, active.headers["Retry-After"]]).toEqual([429, "too-many-requests", "2"]);
    expect([daily.headers["Retry-After"], daily.body.detail]).toEqual(["85800", "You have started 20 jobs in the last 24 hours, the most allowed."]);
    expect(toProblem(tooManyJobs("daily", 0.2)).headers["Retry-After"]).toBe("1"); // never 0
  });
});
