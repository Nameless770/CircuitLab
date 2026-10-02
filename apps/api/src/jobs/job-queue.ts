/** The name BullMQ knows the truth-table queue by. */
export const TRUTH_TABLE_QUEUE = "truth-tables";

/**
 * Hands jobs to workers. JobsModule binds it to BullMQ (with REDIS_URL: any worker process may
 * take a job, and a job outlives the process that queued it) or to a queue inside this process.
 *
 * The queue only carries the job's id. Everything else about a job, and the truth about its
 * status, is in JobsRepository, so the queue losing a job can never make it look done.
 */
export abstract class JobQueue {
  abstract add(jobId: string): Promise<void>;

  /** Rows computed so far, as the worker last reported; 0 if unknown. */
  abstract rowsDone(jobId: string): Promise<number>;

  /**
   * Takes a job that hasn't started out of the queue. A running one isn't touched: its worker
   * checks the job's status between pages and stops itself.
   */
  abstract remove(jobId: string): Promise<void>;
}
