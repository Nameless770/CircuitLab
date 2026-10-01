import type { RunRecord } from "@circuitlab/api-contract";
import type { Prisma, PrismaClient } from "@circuitlab/database";
import { Injectable } from "@nestjs/common";
import { RunsRepository, type NewRun } from "../simulation/runs.repository";
import { PrismaService } from "./prisma.service";
import { UUID } from "./prisma-circuits.repository";

/** The `simulation_runs` table, through Prisma Client. */
@Injectable()
export class PrismaRunsRepository extends RunsRepository {
  constructor(private readonly database: PrismaService) {
    super();
  }

  private get prisma(): PrismaClient {
    return this.database.client;
  }

  async record(run: NewRun): Promise<void> {
    const succeeded = "outputs" in run.outcome;
    await this.prisma.simulationRun.create({
      data: {
        circuitId: run.circuitId,
        circuitVersion: run.circuitVersion,
        userId: run.userId,
        kind: "simulate",
        status: succeeded ? "succeeded" : "failed",
        inputs: run.inputs as Prisma.InputJsonObject,
        ...("outputs" in run.outcome && { outputs: run.outcome.outputs }),
        ...("errorCode" in run.outcome && { errorCode: run.outcome.errorCode }),
        // All three times come from the same clock, so they can't appear out of order.
        createdAt: run.startedAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      },
    });
  }

  /** queries.sql: recent_runs, or recent_runs_by_user with `userId`. */
  async recent(circuitId: string, limit: number, userId?: string): Promise<readonly RunRecord[]> {
    if (!UUID.test(circuitId)) return [];
    const rows = await this.prisma.simulationRun.findMany({
      where: { circuitId, ...(userId !== undefined && { userId }) },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      circuitVersion: row.circuitVersion,
      kind: row.kind,
      status: row.status,
      inputs: (row.inputs as Record<string, unknown> | null) ?? null,
      outputs: (row.outputs as RunRecord["outputs"]) ?? null,
      errorCode: row.errorCode,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
    }));
  }
}
