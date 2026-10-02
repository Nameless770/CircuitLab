// Background truth-table jobs (phase 10), in the contract's terms: which jobs may be started,
// how a job looks to clients, and the errors around them. A job is also a simulation run (kind
// `truth_table`), so it shares the run's id and statuses.

import type { CircuitSummary, RunStatus, TruthTableJobRequest, TruthTableJobResource } from "./dto";
import { LIMITS } from "./limits";
import { ApiError, type ProblemIssue } from "./problems";

/** A job as the storage layer hands it over. */
export interface JobRecord {
  readonly id: string;
  readonly circuitId: string;
  readonly circuitVersion: number;
  readonly userId: string;
  readonly status: RunStatus;
  readonly offset: number;
  readonly limit: number;
  /** The problem code it failed with. */
  readonly errorCode: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
}

/** Waiting or running: neither its result nor its outcome exists yet. */
export function isUnfinished(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

/**
 * Settles which rows a job computes, and checks that it fits. `limit` defaults to the rest of the
 * table and is cut at its end. Three limits apply: rows, work (rows times gates), and the size
 * of the stored result (rows times outputs).
 *
 * @throws ApiError `invalid-fields` (422) for an offset past the end, `computation-too-large` (422) for a job over a limit
 */
export function jobRange(request: TruthTableJobRequest, summary: CircuitSummary): { offset: number; limit: number } {
  const totalRows = 2 ** summary.inputs.length;
  const { offset } = request;
  if (offset >= totalRows) {
    throw new ApiError("invalid-fields", "The job has 1 problem.", {
      issues: [{ code: "OFFSET_PAST_END", message: `the table has ${fmt(totalRows)} rows, so the last offset is ${fmt(totalRows - 1)}`, pointer: "/offset" }],
    });
  }
  const limit = Math.min(request.limit ?? totalRows - offset, totalRows - offset);
  const { maxRows, maxGateEvaluations, maxResultBits } = LIMITS.truthTableJobs;
  const issues: ProblemIssue[] = [];
  const tooMany = (message: string): void => void issues.push({ code: "JOB_TOO_LARGE", message, pointer: "/limit" });
  if (limit > maxRows) tooMany(`a job computes at most ${fmt(maxRows)} rows, and this one asks for ${fmt(limit)}`);
  if (limit * summary.gates > maxGateEvaluations) {
    tooMany(`a job may evaluate at most ${fmt(maxGateEvaluations)} gates in all; ${fmt(limit)} rows of ${fmt(summary.gates)} gates is ${fmt(limit * summary.gates)}`);
  }
  if (limit * summary.outputs.length > maxResultBits) {
    tooMany(`a job's result holds at most ${fmt(maxResultBits)} output values; ${fmt(limit)} rows of ${fmt(summary.outputs.length)} outputs is ${fmt(limit * summary.outputs.length)}`);
  }
  if (issues.length > 0) {
    const most = Math.min(maxRows, Math.floor(maxGateEvaluations / summary.gates), Math.floor(maxResultBits / Math.max(1, summary.outputs.length)));
    throw new ApiError("computation-too-large", `This job is too large. For this circuit, one job can cover at most ${fmt(most)} rows: split the table with offset and limit.`, { issues });
  }
  return { offset, limit };
}

/** When a finished job's result stops being available. */
export function resultExpiry(finishedAt: Date): Date {
  return new Date(finishedAt.getTime() + LIMITS.truthTableJobs.resultHours * 3_600_000);
}

/**
 * A job as clients see it. `rowsDone` comes from the queue while it runs. The result link appears
 * only while the result can be downloaded (`downloadable`: it has neither expired nor been deleted).
 */
export function jobResource(
  job: JobRecord,
  context: { readonly rowsDone: number; readonly downloadable: boolean; readonly basePath: string },
): TruthTableJobResource {
  const self = `${context.basePath}/circuits/${job.circuitId}/truth-table/jobs/${job.id}`;
  const expiresAt = job.status === "succeeded" && job.finishedAt !== null ? resultExpiry(job.finishedAt) : undefined;
  const downloadable = expiresAt !== undefined && context.downloadable;
  return {
    id: job.id,
    circuitId: job.circuitId,
    circuitVersion: job.circuitVersion,
    status: job.status,
    offset: job.offset,
    limit: job.limit,
    rowsDone: job.status === "succeeded" ? job.limit : Math.min(job.limit, context.rowsDone),
    ...(job.errorCode !== null && { errorCode: job.errorCode }),
    createdAt: job.createdAt.toISOString(),
    ...(job.startedAt !== null && { startedAt: job.startedAt.toISOString() }),
    ...(job.finishedAt !== null && { finishedAt: job.finishedAt.toISOString() }),
    ...(expiresAt !== undefined && { expiresAt: expiresAt.toISOString() }),
    links: { self, circuit: `${context.basePath}/circuits/${job.circuitId}`, ...(downloadable && { result: `${self}/result` }) },
  };
}

/** 409: the result was asked for before the job finished. */
export function jobUnfinished(status: RunStatus): ApiError {
  return new ApiError("job-unfinished", `The job is still ${status}. Poll it, and download the result once its status is "succeeded".`, {
    headers: { "Retry-After": String(LIMITS.retryAfterSeconds.jobPoll) },
  });
}

/** 409: the job ended without a result. */
export function jobFailed(job: Pick<JobRecord, "status" | "errorCode">): ApiError {
  const why = job.status === "cancelled" ? "was cancelled" : `failed (${job.errorCode ?? "unknown error"})`;
  return new ApiError("job-failed", `The job ${why}, so it has no result. Start a new job.`);
}

/** 410: the result existed, but has expired or was deleted. */
export function resultGone(): ApiError {
  return new ApiError("result-gone", `The result is no longer kept (results are deleted ${LIMITS.truthTableJobs.resultHours} hours after the job finishes, or when you delete the job). Start a new job.`);
}

/** 429: the user's job allowance is used up for now. */
export function tooManyJobs(reason: "active" | "daily", retryAfterSeconds: number): ApiError {
  const { activePerUser, perUserPerDay } = LIMITS.truthTableJobs;
  const detail =
    reason === "active"
      ? `You already have ${activePerUser} jobs waiting or running. Wait for one to finish, or delete one.`
      : `You have started ${perUserPerDay} jobs in the last 24 hours, the most allowed.`;
  return new ApiError("too-many-requests", detail, { headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) } });
}

const fmt = (n: number): string => n.toLocaleString("en");
