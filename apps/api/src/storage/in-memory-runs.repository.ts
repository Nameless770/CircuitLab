import { randomUUID } from "node:crypto";
import type { RunRecord } from "@circuitlab/api-contract";
import { Injectable } from "@nestjs/common";
import { RunsRepository, type NewRun } from "../simulation/runs.repository";

/** Runs kept per circuit, oldest dropped first, so a long-running process doesn't grow forever. */
const RUNS_KEPT_PER_CIRCUIT = 1000;

@Injectable()
export class InMemoryRunsRepository extends RunsRepository {
  private readonly runs = new Map<string, { readonly run: RunRecord; readonly userId: string | null }[]>();

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
        errorCode: "errorCode" in run.outcome ? run.outcome.errorCode : null,
        createdAt: run.startedAt,
        finishedAt: run.finishedAt,
      },
    });
    this.runs.set(run.circuitId, list.slice(0, RUNS_KEPT_PER_CIRCUIT));
  }

  async recent(circuitId: string, limit: number, userId?: string): Promise<readonly RunRecord[]> {
    return (this.runs.get(circuitId) ?? [])
      .filter((entry) => userId === undefined || entry.userId === userId)
      .slice(0, limit)
      .map((entry) => entry.run);
  }
}
