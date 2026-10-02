import { ApiError, LIMITS, resultExpiry, toProblem } from "@circuitlab/api-contract";
import type { CircuitSummary, JobRecord } from "@circuitlab/api-contract";
import { Injectable, Logger } from "@nestjs/common";
import { CircuitsRepository } from "../circuits/circuits.repository";
import { Clock } from "../common/clock";
import { outageAsProblem } from "../common/outages";
import { packRows } from "../simulation/packed-rows";
import { SimulationPoolService } from "../simulation/simulation-pool.service";
import { JobResults } from "./job-results";
import { JobsRepository } from "./jobs.repository";

/** How a job ended, from the processor's side. */
export type JobOutcome = "succeeded" | "failed" | "cancelled" | "skipped";

export interface ProcessOptions {
  /** Stops the job from outside: the process is shutting down. It will be retried. */
  readonly signal: AbortSignal;
  /** Called after every page with the rows done so far. */
  readonly progress: (rows: number) => Promise<void> | void;
  /** Whether a failure now is the last attempt, so the job must be marked failed. Otherwise it will be retried. */
  readonly finalAttempt: boolean;
}

/**
 * A failure that a retry can't fix: the circuit changed, it needs too much memory, it ran out of
 * time. BullMQ is told not to retry it.
 */
export class PermanentJobError extends Error {
  override readonly name = "PermanentJobError";
}

/** Gate evaluations in one page: about 60 ms on one worker thread, so a page never holds a worker for long. */
const PAGE_WORK = 2 ** 20;
/** Output values in one page as it travels from a worker (one byte each). */
const PAGE_VALUES = 2 ** 20;
/** How often a running job asks whether it has been cancelled. */
const CANCEL_CHECK_MS = 250;

/**
 * Computes one truth-table job: the work behind every job, whichever queue delivered it (BullMQ, or
 * the in-process queue). It runs pages on the simulation worker threads, packs each page into bits,
 * stores it, and reports progress, then marks the job done.
 *
 * Every status change is a compare-and-swap (JobsRepository), so this works even when the job is
 * cancelled halfway, or a worker crashes and BullMQ hands the job to another one.
 */
@Injectable()
export class TruthTableJobProcessor {
  private readonly logger = new Logger(TruthTableJobProcessor.name);

  constructor(
    private readonly jobs: JobsRepository,
    private readonly circuits: CircuitsRepository,
    private readonly results: JobResults,
    private readonly pool: SimulationPoolService,
    private readonly clock: Clock,
  ) {}

  /**
   * @throws PermanentJobError when retrying can't help (the job is already marked failed)
   * @throws anything else when it might (a database or Redis outage, shutting down)
   */
  async process(jobId: string, options: ProcessOptions): Promise<JobOutcome> {
    const job = await this.jobs.start(jobId, this.clock.now());
    if (job === undefined) return "skipped"; // cancelled while it waited, or deleted with its circuit
    const cancelled = new AbortController();
    const timeout = AbortSignal.timeout(LIMITS.truthTableJobs.timeoutMinutes * 60_000);
    try {
      await this.compute(job, AbortSignal.any([options.signal, cancelled.signal, timeout]), options, cancelled);
      if (await this.jobs.complete(job.id, this.clock.now())) return "succeeded";
      await this.results.delete(job.id); // cancelled just as it finished
      return "cancelled";
    } catch (error) {
      await this.results.delete(job.id).catch(() => {}); // a partial result is of no use
      if (cancelled.signal.aborted) return "cancelled";
      if (options.signal.aborted) throw error; // stopped from outside (shutting down): the queue hands it out again
      const { status, body } = toProblem(outageAsProblem(error));
      // A 4xx means this job can never succeed; so does running out of time.
      const permanent = status < 500 || body.code === "simulation-timeout";
      if (permanent || options.finalAttempt) {
        await this.jobs.fail(job.id, this.clock.now(), body.code);
        if (status >= 500 && !permanent) this.logger.error(`Job ${job.id} failed for good`, error instanceof Error ? error.stack : String(error));
      }
      if (permanent) throw new PermanentJobError(`${body.code}: ${body.detail ?? body.title}`, { cause: error });
      throw error;
    }
  }

  private async compute(job: JobRecord, signal: AbortSignal, options: ProcessOptions, cancelled: AbortController): Promise<void> {
    const circuit = await this.circuits.find(job.circuitId);
    if (circuit === undefined) throw new ApiError("not-found", "The circuit was deleted.");
    if (circuit.version !== job.circuitVersion) {
      throw new ApiError("version-conflict", `The circuit changed (to version ${circuit.version}) before the job began.`);
    }
    const essentials = { gates: circuit.gates, wires: circuit.wires };
    const pages = this.pool.packedTruthTablePages(essentials, { offset: job.offset, limit: job.limit, pageSize: pageRows(circuit.summary), signal });
    let chunks = 0;
    let rows = 0;
    let checked = performance.now();
    let shape: { inputIds: readonly string[]; outputIds: readonly string[]; totalRows: number } | undefined;
    for await (const page of pages) {
      shape ??= { inputIds: page.inputIds, outputIds: page.outputIds, totalRows: page.totalRows };
      await this.results.append(job.id, chunks++, packRows(page));
      rows += page.rowCount;
      await options.progress(rows);
      if (performance.now() - checked >= CANCEL_CHECK_MS) {
        checked = performance.now();
        if ((await this.jobs.status(job.id)) !== "running") cancelled.abort(new DOMException("The job was cancelled", "AbortError"));
        signal.throwIfAborted();
      }
    }
    if (shape === undefined) throw new Error(`Job ${job.id} computed no rows`);
    await this.results.finish(job.id, { ...shape, offset: job.offset, limit: job.limit, chunks, expiresAt: resultExpiry(this.clock.now()) });
  }
}

/** Rows per page: a bounded amount of work, and of memory, whatever the circuit. */
export function pageRows(summary: Pick<CircuitSummary, "gates" | "outputs">): number {
  return Math.max(1, Math.min(65_536, Math.floor(PAGE_WORK / Math.max(1, summary.gates)), Math.floor(PAGE_VALUES / Math.max(1, summary.outputs.length))));
}
