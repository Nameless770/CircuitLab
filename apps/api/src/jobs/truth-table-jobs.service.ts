import {
  ApiError,
  LIMITS,
  checkExpectedVersion,
  checkTruthTableAllowed,
  isUnfinished,
  jobFailed,
  jobRange,
  jobResource,
  jobUnfinished,
  resultExpiry,
  resultGone,
  tooManyJobs,
} from "@circuitlab/api-contract";
import type { JobRecord, TruthTableJobRequest, TruthTableJobResource } from "@circuitlab/api-contract";
import type { TruthTable } from "@circuitlab/engine";
import { unpack } from "@circuitlab/runner";
import { Injectable } from "@nestjs/common";
import type { AuthUser } from "../auth/auth-user";
import { CircuitsService } from "../circuits/circuits.service";
import { Clock } from "../common/clock";
import { slices, unpackRows } from "../simulation/packed-rows";
import { JobQueue } from "./job-queue";
import { JobResults } from "./job-results";
import { JobsRepository, type JobAllowance } from "./jobs.repository";

/** Links in job resources start here. */
const BASE_PATH = "/v1";
/** Rows turned into objects and text at a time while downloading: a few milliseconds of the main thread. */
const DOWNLOAD_SLICE_ROWS = 4096;

/**
 * Truth-table jobs, as the API offers them: start one, follow it, download its rows, cancel it.
 * The computing happens elsewhere (TruthTableJobProcessor, fed by the JobQueue).
 *
 * A job is visible only to the person who started it, and only while they can still read the
 * circuit: losing access to a circuit means losing access to its tables too. Anyone who can read
 * a circuit may start jobs for it, as long as they are signed in (a job is kept on their behalf,
 * and counts against their allowance).
 */
@Injectable()
export class TruthTableJobsService {
  constructor(
    private readonly circuits: CircuitsService,
    private readonly jobs: JobsRepository,
    private readonly queue: JobQueue,
    private readonly results: JobResults,
    private readonly clock: Clock,
  ) {}

  /**
   * @throws ApiError `not-found` (404), `version-conflict` (409), `feedback-loop`, `too-many-inputs`,
   *   `computation-too-large` or `invalid-fields` (422), `too-many-requests` (429)
   */
  async create(circuitId: string, request: TruthTableJobRequest, user: AuthUser): Promise<TruthTableJobResource> {
    const record = await this.circuits.get(circuitId, user);
    checkExpectedVersion(request.version, record.version);
    checkTruthTableAllowed(record.summary);
    const range = jobRange(request, record.summary);
    const now = this.clock.now();
    const { job, existing } = await this.jobs.create({ circuitId, circuitVersion: record.version, userId: user.id, ...range, createdAt: now }, (allowance) =>
      checkAllowance(allowance, now),
    );
    if (!existing) {
      try {
        await this.queue.add(job.id);
      } catch (error) {
        // Not queued, so it would never run. The client gets the error (a 503: try again), and
        // the job is forgotten. Should Redis have taken it after all (its answer lost on the way),
        // the worker finds no job to start, and skips it. If even forgetting fails, housekeeping
        // fails the job an hour later.
        await this.jobs.discard(job.id).catch(() => {});
        throw error;
      }
    }
    return jobResource(job, { rowsDone: 0, downloadable: false, basePath: BASE_PATH });
  }

  /** @throws ApiError `not-found` (404) */
  async get(circuitId: string, jobId: string, user: AuthUser): Promise<TruthTableJobResource> {
    const job = await this.find(circuitId, jobId, user);
    // Progress is a nicety: if the queue can't say (Redis is briefly down), the job is still reported.
    const rowsDone = job.status === "running" ? await this.queue.rowsDone(job.id).catch(() => 0) : 0;
    return jobResource(job, { rowsDone, downloadable: await this.downloadable(job), basePath: BASE_PATH });
  }

  /**
   * The job's rows, as truth-table pages, ready to encode as CSV or NDJSON.
   * @throws ApiError `not-found` (404), `job-unfinished` or `job-failed` (409), `result-gone` (410)
   */
  async result(circuitId: string, jobId: string, user: AuthUser): Promise<{ readonly job: JobRecord; readonly pages: AsyncIterable<TruthTable> }> {
    const job = await this.find(circuitId, jobId, user);
    if (isUnfinished(job.status)) throw jobUnfinished(job.status);
    if (job.status !== "succeeded" || job.finishedAt === null) throw jobFailed(job);
    if (this.clock.now() >= resultExpiry(job.finishedAt)) throw resultGone();
    const stored = await this.results.open(job.id);
    if (stored === undefined) throw resultGone(); // deleted, or lost (Redis restarted without its data)
    const { header } = stored;
    const chunks = stored.chunks();
    async function* pages(): AsyncGenerator<TruthTable, void, undefined> {
      for await (const chunk of chunks) {
        for (const slice of slices(unpackRows(chunk, header), DOWNLOAD_SLICE_ROWS)) {
          yield unpack(slice);
          await new Promise<void>((resolve) => setImmediate(resolve)); // let other requests in between slices
        }
      }
    }
    return { job, pages: pages() };
  }

  /**
   * Cancels a job that is waiting or running; deletes a finished job's result. Either way the job
   * stays in the circuit's run history.
   *
   * @throws ApiError `not-found` (404)
   */
  async delete(circuitId: string, jobId: string, user: AuthUser): Promise<void> {
    const job = await this.find(circuitId, jobId, user);
    if (isUnfinished(job.status)) {
      // The record is the truth: once it says cancelled, no worker will start the job, and a
      // running one stops at its next look (or can't mark it succeeded). Taking it out of the
      // queue only saves a worker the trip, so a failure there doesn't matter.
      await this.jobs.cancel(job.id, this.clock.now());
      await this.queue.remove(job.id).catch(() => {});
    }
    await this.results.delete(job.id);
  }

  private async find(circuitId: string, jobId: string, user: AuthUser): Promise<JobRecord> {
    await this.circuits.authorize(circuitId, user, "read");
    const job = await this.jobs.find(jobId, circuitId, user.id);
    if (job === undefined) throw new ApiError("not-found", `This circuit has no job ${JSON.stringify(jobId.slice(0, 64))} of yours.`);
    return job;
  }

  /** Whether the result can be downloaded now. While Redis can't say, the job is still reported, without the link. */
  private async downloadable(job: JobRecord): Promise<boolean> {
    if (job.status !== "succeeded" || job.finishedAt === null || this.clock.now() >= resultExpiry(job.finishedAt)) return false;
    return (await this.results.open(job.id).catch(() => undefined)) !== undefined;
  }
}

/** @throws ApiError `too-many-requests` (429) when the user may not start another job now */
function checkAllowance(allowance: JobAllowance, now: Date): void {
  const { activePerUser, perUserPerDay } = LIMITS.truthTableJobs;
  if (allowance.unfinished >= activePerUser) throw tooManyJobs("active", LIMITS.retryAfterSeconds.jobPoll);
  if (allowance.started >= perUserPerDay) {
    const oldest = allowance.oldest ?? now;
    throw tooManyJobs("daily", (oldest.getTime() + 24 * 60 * 60 * 1000 - now.getTime()) / 1000);
  }
}
