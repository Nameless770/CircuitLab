import { toProblem } from "@circuitlab/api-contract";
import { PoolClosedError } from "@circuitlab/runner";
import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { AppConfig } from "../config/app-config";
import { JobQueue } from "./job-queue";
import { PermanentJobError, TruthTableJobProcessor } from "./truth-table-job.processor";

/**
 * The job queue without Redis: an array in this process, worked through JOB_CONCURRENCY jobs at a
 * time, on this process's simulation pool. Good for development and tests. Its limits are the
 * reasons BullMQ exists: jobs waiting here are lost when the process stops, only this process can
 * work on them, and a failed job isn't retried.
 */
@Injectable()
export class InProcessJobQueue extends JobQueue implements OnApplicationShutdown {
  private readonly logger = new Logger("Jobs");
  private readonly waiting: string[] = [];
  private readonly running = new Map<string, { readonly stop: AbortController; readonly done: Promise<void> }>();
  private readonly progress = new Map<string, number>();
  private closed = false;

  constructor(
    private readonly processor: TruthTableJobProcessor,
    private readonly config: AppConfig,
  ) {
    super();
  }

  async add(jobId: string): Promise<void> {
    if (this.closed) throw new PoolClosedError();
    this.waiting.push(jobId);
    this.next();
  }

  async rowsDone(jobId: string): Promise<number> {
    return this.progress.get(jobId) ?? 0;
  }

  async remove(jobId: string): Promise<void> {
    const index = this.waiting.indexOf(jobId);
    if (index !== -1) this.waiting.splice(index, 1);
  }

  /** Stops taking jobs, and stops the running ones (they stay "running" until housekeeping fails them). */
  async onApplicationShutdown(): Promise<void> {
    this.closed = true;
    this.waiting.length = 0;
    for (const { stop } of this.running.values()) stop.abort(new PoolClosedError());
    await Promise.all([...this.running.values()].map(({ done }) => done));
  }

  private next(): void {
    while (!this.closed && this.running.size < Math.max(1, this.config.jobConcurrency)) {
      const jobId = this.waiting.shift();
      if (jobId === undefined) return;
      const stop = new AbortController();
      const done = this.work(jobId, stop.signal).finally(() => {
        this.running.delete(jobId);
        this.progress.delete(jobId);
        this.next();
      });
      this.running.set(jobId, { stop, done });
    }
  }

  private async work(jobId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.processor.process(jobId, { signal, progress: (rows) => void this.progress.set(jobId, rows), finalAttempt: true });
    } catch (error) {
      if (signal.aborted) return; // shutting down
      if (!(error instanceof PermanentJobError)) {
        this.logger.error(`Job ${jobId} failed (${toProblem(error).body.code})`, error instanceof Error ? error.stack : String(error));
      }
    }
  }
}
