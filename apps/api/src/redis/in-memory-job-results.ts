import { Injectable } from "@nestjs/common";
import { Clock } from "../common/clock";
import { JobResults, type ResultHeader, type StoredResult } from "../jobs/job-results";
import type { StoredRows } from "../simulation/packed-rows";

/**
 * Results in a Map, for one process. Expired ones are dropped whenever another one finishes. (Like
 * Redis's expiry, that only frees memory: TruthTableJobsService decides whether a result has expired.)
 */
@Injectable()
export class InMemoryJobResults extends JobResults {
  private readonly results = new Map<string, { header?: ResultHeader; readonly chunks: StoredRows[] }>();

  constructor(private readonly clock: Clock) {
    super();
  }

  async append(jobId: string, index: number, rows: StoredRows): Promise<void> {
    const result = this.results.get(jobId) ?? { chunks: [] };
    result.chunks[index] = rows;
    this.results.set(jobId, result);
  }

  async finish(jobId: string, header: ResultHeader): Promise<void> {
    const now = this.clock.now();
    for (const [id, result] of this.results) if (result.header !== undefined && result.header.expiresAt <= now) this.results.delete(id);
    const result = this.results.get(jobId);
    if (result !== undefined) result.header = header;
  }

  async open(jobId: string): Promise<StoredResult | undefined> {
    const result = this.results.get(jobId);
    const header = result?.header;
    if (result === undefined || header === undefined) return undefined;
    return {
      header,
      async *chunks() {
        yield* result.chunks;
      },
    };
  }

  async delete(jobId: string): Promise<void> {
    this.results.delete(jobId);
  }
}
