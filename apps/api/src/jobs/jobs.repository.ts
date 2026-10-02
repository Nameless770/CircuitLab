import type { JobRecord, RunStatus } from "@circuitlab/api-contract";

/** A job about to be stored, queued. */
export interface NewJob {
  readonly circuitId: string;
  readonly circuitVersion: number;
  readonly userId: string;
  readonly offset: number;
  readonly limit: number;
  readonly createdAt: Date;
}

/** What a user may still start (queries.sql: job_allowance). */
export interface JobAllowance {
  /** Jobs they started in the last 24 hours. */
  readonly started: number;
  /** Of those, the ones still waiting or running. */
  readonly unfinished: number;
  /** When the oldest of them was started: 24 hours later, the allowance grows again. */
  readonly oldest: Date | undefined;
}

/**
 * Truth-table jobs, which are simulation runs of kind `truth_table` (so they also appear in the
 * circuit's run history). Bound like the other repositories: PostgreSQL or memory.
 *
 * A job's status only moves forward: queued, running, then succeeded, failed or cancelled. Every
 * change is a compare-and-swap on the status, so when a cancellation and a finishing worker race,
 * exactly one of them wins, and the other learns it lost (false, or undefined).
 */
export abstract class JobsRepository {
  /**
   * Starts a job, unless the user already has the identical one (same circuit version and rows)
   * waiting or running: then that one comes back, `existing`. Otherwise `allow` sees the user's
   * allowance and throws to refuse. All of it happens one request per user at a time, so two
   * requests at once can't both slip under the allowance.
   */
  abstract create(job: NewJob, allow: (allowance: JobAllowance) => void): Promise<{ readonly job: JobRecord; readonly existing: boolean }>;

  /** The job, if `userId` started it on this circuit. */
  abstract find(id: string, circuitId: string, userId: string): Promise<JobRecord | undefined>;

  /** A worker takes the job (again, after a failed attempt). Undefined if it was cancelled, failed, or deleted with its circuit. */
  abstract start(id: string, now: Date): Promise<JobRecord | undefined>;

  /** Undefined if the job no longer exists. */
  abstract status(id: string): Promise<RunStatus | undefined>;

  /** Running to succeeded. False if it had been cancelled meanwhile. */
  abstract complete(id: string, now: Date): Promise<boolean>;

  /** Queued or running to failed, with the problem code. */
  abstract fail(id: string, now: Date, errorCode: string): Promise<boolean>;

  /** Queued or running to cancelled. */
  abstract cancel(id: string, now: Date): Promise<boolean>;

  /**
   * Forgets a job that couldn't be queued. Its request was answered with 503, and, like a
   * simulation turned away, it leaves no trace (nor uses up any of the user's allowance). Only a
   * job still queued is removed.
   */
  abstract discard(id: string): Promise<void>;

  /** Housekeeping: fails every job still unfinished that was started before `before`. Returns their ids. */
  abstract failAbandoned(now: Date, before: Date): Promise<readonly string[]>;
}
