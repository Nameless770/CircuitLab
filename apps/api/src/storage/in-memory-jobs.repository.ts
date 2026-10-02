import { randomUUID } from "node:crypto";
import { isUnfinished, type JobRecord, type RunStatus } from "@circuitlab/api-contract";
import { Injectable } from "@nestjs/common";
import { JobsRepository, type JobAllowance, type NewJob } from "../jobs/jobs.repository";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Finished jobs are forgotten this long after they were started, so a long-running process doesn't grow forever. */
const KEPT_MS = 7 * DAY_MS;

/**
 * Jobs in a Map, for when there is no database. Each method checks and changes a job without an
 * await in between, so, JavaScript being single-threaded, no other request can interleave: the
 * same guarantees as the SQL's locks and compare-and-swap updates.
 */
@Injectable()
export class InMemoryJobsRepository extends JobsRepository {
  private readonly jobs = new Map<string, JobRecord>();

  async create(job: NewJob, allow: (allowance: JobAllowance) => void): Promise<{ readonly job: JobRecord; readonly existing: boolean }> {
    const now = job.createdAt.getTime();
    for (const [id, old] of this.jobs) if (!isUnfinished(old.status) && now - old.createdAt.getTime() > KEPT_MS) this.jobs.delete(id);
    const theirs = [...this.jobs.values()].filter((other) => other.userId === job.userId);
    const same = theirs.find(
      (other) =>
        isUnfinished(other.status) &&
        other.circuitId === job.circuitId &&
        other.circuitVersion === job.circuitVersion &&
        other.offset === job.offset &&
        other.limit === job.limit,
    );
    if (same !== undefined) return { job: same, existing: true };
    const recent = theirs.filter((other) => other.createdAt.getTime() > now - DAY_MS);
    allow({
      started: recent.length,
      unfinished: recent.filter((other) => isUnfinished(other.status)).length,
      oldest: recent.reduce<Date | undefined>((oldest, other) => (oldest === undefined || other.createdAt < oldest ? other.createdAt : oldest), undefined),
    });
    const created: JobRecord = { ...job, id: randomUUID(), status: "queued", errorCode: null, startedAt: null, finishedAt: null };
    this.jobs.set(created.id, created);
    return { job: created, existing: false };
  }

  async find(id: string, circuitId: string, userId: string): Promise<JobRecord | undefined> {
    const job = this.jobs.get(id);
    return job !== undefined && job.circuitId === circuitId && job.userId === userId ? job : undefined;
  }

  async start(id: string, now: Date): Promise<JobRecord | undefined> {
    return this.change(id, ["queued", "running"], { status: "running", startedAt: now });
  }

  async status(id: string): Promise<RunStatus | undefined> {
    return this.jobs.get(id)?.status;
  }

  async complete(id: string, now: Date): Promise<boolean> {
    return this.change(id, ["running"], { status: "succeeded", finishedAt: now }) !== undefined;
  }

  async fail(id: string, now: Date, errorCode: string): Promise<boolean> {
    return this.change(id, ["queued", "running"], { status: "failed", finishedAt: now, errorCode }) !== undefined;
  }

  async cancel(id: string, now: Date): Promise<boolean> {
    return this.change(id, ["queued", "running"], { status: "cancelled", finishedAt: now }) !== undefined;
  }

  async discard(id: string): Promise<void> {
    if (this.jobs.get(id)?.status === "queued") this.jobs.delete(id);
  }

  async failAbandoned(now: Date, before: Date): Promise<readonly string[]> {
    const abandoned = [...this.jobs.values()].filter((job) => isUnfinished(job.status) && job.createdAt < before);
    for (const job of abandoned) this.change(job.id, ["queued", "running"], { status: "failed", finishedAt: now, errorCode: "internal-error" });
    return abandoned.map((job) => job.id);
  }

  /** A circuit's jobs, for its run history. */
  forCircuit(circuitId: string): readonly JobRecord[] {
    return [...this.jobs.values()].filter((job) => job.circuitId === circuitId);
  }

  /** The compare-and-swap: changes the job only if its status is one of `from`. */
  private change(id: string, from: readonly RunStatus[], changes: Partial<JobRecord>): JobRecord | undefined {
    const job = this.jobs.get(id);
    if (job === undefined || !from.includes(job.status)) return undefined;
    const changed = { ...job, ...changes };
    this.jobs.set(id, changed);
    return changed;
  }
}
