import { randomUUID } from "node:crypto";
import type { JobRecord, RunRecord } from "@circuitlab/api-contract";
import { Injectable } from "@nestjs/common";
import { RunsRepository, type NewRun } from "../simulation/runs.repository";
import { InMemoryJobsRepository } from "./in-memory-jobs.repository";

/** Runs kept per circuit, oldest dropped first, so a long-running process doesn't grow forever. */
const RUNS_KEPT_PER_CIRCUIT = 1000;

/**
 * Simulations in a Map. A circuit's history also lists its truth-table jobs, which
 * InMemoryJobsRepository keeps (in SQL, both are rows of simulation_runs).
 */
@Injectable()
export class InMemoryRunsRepository extends RunsRepository {
  private readonly runs = new Map<string, { readonly run: RunRecord; readonly userId: string | null }[]>();

  constructor(private readonly jobs: InMemoryJobsRepository) {
    super();
  }

  async record(run: NewRun): Promise<void> {
    const list = this.runs.get(run.circuitId) ?? [];
    list.unshift({
      userId: run.userId,
      run: {
        id: randomUUID(),
        circuitVersion: run.circuitVersion,
        kind: "simulate",
        mode: run.mode,
        status: "outputs" in run.outcome ? "succeeded" : "failed",
        inputs: structuredClone(run.inputs),
        outputs: "outputs" in run.outcome ? structuredClone(run.outcome.outputs) : null,
        offset: null,
        limit: null,
        errorCode: "errorCode" in run.outcome ? run.outcome.errorCode : null,
        createdAt: run.startedAt,
        finishedAt: run.finishedAt,
      },
    });
    this.runs.set(run.circuitId, list.slice(0, RUNS_KEPT_PER_CIRCUIT));
  }

  async recent(circuitId: string, limit: number, userId?: string): Promise<readonly RunRecord[]> {
    // Newest first, like the simulations, so equal times keep the newest first after the (stable) sort.
    const jobs = [...this.jobs.forCircuit(circuitId)].reverse().map((job) => ({ userId: job.userId, run: jobRun(job) }));
    return [...(this.runs.get(circuitId) ?? []), ...jobs]
      .filter((entry) => userId === undefined || entry.userId === userId)
      .sort((a, b) => b.run.createdAt.getTime() - a.run.createdAt.getTime())
      .slice(0, limit)
      .map((entry) => entry.run);
  }
}

function jobRun(job: JobRecord): RunRecord {
  return {
    id: job.id,
    circuitVersion: job.circuitVersion,
    kind: "truth_table",
    mode: "combinational",
    status: job.status,
    inputs: null,
    outputs: null,
    offset: job.offset,
    limit: job.limit,
    errorCode: job.errorCode,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}
