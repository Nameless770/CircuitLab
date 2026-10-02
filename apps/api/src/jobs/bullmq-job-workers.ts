import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import { AppConfig } from "../config/app-config";
import { isConnectionError } from "../redis/redis-errors";
import { RedisService } from "../redis/redis.service";
import type { TruthTableJobData } from "./bullmq-job-queue";
import { HOUSEKEEPING_EVERY_MS, Housekeeping } from "./housekeeping.service";
import { TRUTH_TABLE_QUEUE } from "./job-queue";
import { PermanentJobError, TruthTableJobProcessor, type JobOutcome } from "./truth-table-job.processor";

const HOUSEKEEPING_QUEUE = "housekeeping";

/**
 * The consumer half of the BullMQ queue: workers that take truth-table jobs from Redis and compute
 * them, JOB_CONCURRENCY at a time. They run in API instances (unless JOB_CONCURRENCY is 0) and in
 * worker processes (`npm run start:worker`), all sharing one queue.
 *
 * What BullMQ adds over the in-process queue:
 * - a job survives the process that queued it, and any worker can take it;
 * - a failed attempt is retried (3 attempts in all), unless the failure is permanent;
 * - a worker that dies mid-job loses its lock on the job, and another worker takes the job over;
 * - housekeeping runs every 10 minutes from a job scheduler: once in all, however many processes.
 */
@Injectable()
export class BullMqJobWorkers implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("Jobs");
  private workers: Worker[] = [];
  private schedule: Queue | undefined;

  constructor(
    private readonly processor: TruthTableJobProcessor,
    private readonly housekeeping: Housekeeping,
    private readonly redis: RedisService,
    private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const options = { connection: this.redis.bullConnection("worker"), prefix: this.redis.bullPrefix };
    const truthTables = new Worker<TruthTableJobData, JobOutcome>(TRUTH_TABLE_QUEUE, (job, _token, signal) => this.compute(job, signal), {
      ...options,
      concurrency: Math.max(1, this.config.jobConcurrency),
    });
    const housekeeping = new Worker(HOUSEKEEPING_QUEUE, () => this.housekeeping.run(), { ...options, concurrency: 1 });
    this.workers = [truthTables, housekeeping];
    const report = (error: Error): void => {
      if (!isConnectionError(error)) this.logger.warn(`BullMQ: ${error.message}`);
    };
    for (const worker of this.workers) worker.on("error", report);
    this.schedule = new Queue(HOUSEKEEPING_QUEUE, { connection: this.redis.bullConnection("queue"), prefix: this.redis.bullPrefix });
    this.schedule.on("error", report);
    // Every process with workers says the same, and BullMQ keeps one schedule.
    await this.schedule.upsertJobScheduler("housekeeping", { every: HOUSEKEEPING_EVERY_MS }, { name: "housekeeping" });
  }

  /**
   * Stops taking jobs and lets running ones finish, for up to SHUTDOWN_GRACE_MS. Jobs still running
   * then are stopped; their attempt counts as failed, and BullMQ hands them to another worker.
   */
  async onApplicationShutdown(): Promise<void> {
    const deadline = setTimeout(() => {
      this.logger.warn(`Jobs still running after ${this.config.shutdownGraceMs} ms; stopping them (they will be retried)`);
      for (const worker of this.workers) worker.cancelAllJobs("shutting down");
    }, this.config.shutdownGraceMs);
    try {
      await Promise.all([...this.workers.map((worker) => worker.close()), this.schedule?.close()]);
    } finally {
      clearTimeout(deadline);
    }
  }

  private async compute(job: Job<TruthTableJobData, JobOutcome>, signal: AbortSignal | undefined): Promise<JobOutcome> {
    try {
      return await this.processor.process(job.data.jobId, {
        signal: signal ?? new AbortController().signal,
        progress: (rows) => job.updateProgress(rows),
        // attemptsMade counts the attempts that failed before this one.
        finalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1),
      });
    } catch (error) {
      if (error instanceof PermanentJobError) throw new UnrecoverableError(error.message); // BullMQ: don't retry
      throw error;
    }
  }
}
