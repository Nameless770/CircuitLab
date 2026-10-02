import type { JobRecord } from "@circuitlab/api-contract";
import type { PrismaClient, SimulationRunRow } from "@circuitlab/database";
import { Injectable } from "@nestjs/common";
import { JobsRepository, type JobAllowance, type NewJob } from "../jobs/jobs.repository";
import { UUID } from "./prisma-circuits.repository";
import { PrismaService } from "./prisma.service";

const UNFINISHED = ["queued", "running"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Truth-table jobs: rows of `simulation_runs` with kind 'truth_table'. See queries.sql, "Truth-table jobs". */
@Injectable()
export class PrismaJobsRepository extends JobsRepository {
  constructor(private readonly database: PrismaService) {
    super();
  }

  private get prisma(): PrismaClient {
    return this.database.client;
  }

  /**
   * queries.sql: lock_user_jobs, identical_unfinished_job, job_allowance, then insert_job, in one
   * transaction. The advisory lock is per user and lasts until the transaction ends: a second
   * request from the same user waits for the first to commit, then sees its job.
   */
  async create(job: NewJob, allow: (allowance: JobAllowance) => void): Promise<{ readonly job: JobRecord; readonly existing: boolean }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${job.userId}::text, 0))`;
      const same = await tx.simulationRun.findFirst({
        where: {
          userId: job.userId,
          kind: "truth_table",
          status: { in: [...UNFINISHED] },
          circuitId: job.circuitId,
          circuitVersion: job.circuitVersion,
          rowOffset: BigInt(job.offset),
          rowLimit: job.limit,
        },
        orderBy: { createdAt: "desc" },
      });
      if (same !== null) return { job: toJob(same), existing: true };
      const since = new Date(job.createdAt.getTime() - DAY_MS);
      const [row] = await tx.$queryRaw<{ started: bigint; unfinished: bigint; oldest: Date | null }[]>`
        SELECT count(*) AS started, count(*) FILTER (WHERE status IN ('queued', 'running')) AS unfinished, min(created_at) AS oldest
        FROM simulation_runs
        WHERE user_id = ${job.userId}::uuid AND kind = 'truth_table' AND created_at > ${since}`;
      allow({ started: Number(row?.started ?? 0), unfinished: Number(row?.unfinished ?? 0), oldest: row?.oldest ?? undefined });
      const created = await tx.simulationRun.create({
        data: {
          circuitId: job.circuitId,
          circuitVersion: job.circuitVersion,
          userId: job.userId,
          kind: "truth_table",
          status: "queued",
          rowOffset: BigInt(job.offset),
          rowLimit: job.limit,
          createdAt: job.createdAt,
        },
      });
      return { job: toJob(created), existing: false };
    });
  }

  /** queries.sql: get_job */
  async find(id: string, circuitId: string, userId: string): Promise<JobRecord | undefined> {
    if (!UUID.test(id) || !UUID.test(circuitId)) return undefined;
    const row = await this.prisma.simulationRun.findFirst({ where: { id, circuitId, userId, kind: "truth_table" } });
    return row === null ? undefined : toJob(row);
  }

  /** queries.sql: start_job */
  async start(id: string, now: Date): Promise<JobRecord | undefined> {
    const [row] = await this.prisma.simulationRun.updateManyAndReturn({
      where: { id, kind: "truth_table", status: { in: [...UNFINISHED] } },
      data: { status: "running", startedAt: now },
    });
    return row === undefined ? undefined : toJob(row);
  }

  /** queries.sql: job_status */
  async status(id: string): Promise<JobRecord["status"] | undefined> {
    return (await this.prisma.simulationRun.findUnique({ where: { id }, select: { status: true } }))?.status;
  }

  /** queries.sql: complete_job */
  async complete(id: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.simulationRun.updateMany({ where: { id, status: "running" }, data: { status: "succeeded", finishedAt: now } });
    return count === 1;
  }

  /** queries.sql: fail_job */
  async fail(id: string, now: Date, errorCode: string): Promise<boolean> {
    const { count } = await this.prisma.simulationRun.updateMany({
      where: { id, status: { in: [...UNFINISHED] } },
      data: { status: "failed", finishedAt: now, errorCode },
    });
    return count === 1;
  }

  /** queries.sql: cancel_job */
  async cancel(id: string, now: Date): Promise<boolean> {
    const { count } = await this.prisma.simulationRun.updateMany({ where: { id, status: { in: [...UNFINISHED] } }, data: { status: "cancelled", finishedAt: now } });
    return count === 1;
  }

  /** queries.sql: discard_job */
  async discard(id: string): Promise<void> {
    await this.prisma.simulationRun.deleteMany({ where: { id, kind: "truth_table", status: "queued" } });
  }

  /** queries.sql: fail_abandoned_jobs */
  async failAbandoned(now: Date, before: Date): Promise<readonly string[]> {
    const rows = await this.prisma.simulationRun.updateManyAndReturn({
      where: { status: { in: [...UNFINISHED] }, createdAt: { lt: before } },
      data: { status: "failed", finishedAt: now, errorCode: "internal-error" },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }
}

function toJob(row: SimulationRunRow): JobRecord {
  return {
    id: row.id,
    circuitId: row.circuitId,
    circuitVersion: row.circuitVersion,
    userId: row.userId ?? "",
    status: row.status,
    offset: Number(row.rowOffset ?? 0),
    limit: row.rowLimit ?? 0,
    errorCode: row.errorCode,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}
