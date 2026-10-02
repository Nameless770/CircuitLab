import type { StoredRows, TableShape } from "../simulation/packed-rows";

/** What a finished result says about itself. */
export interface ResultHeader extends TableShape {
  readonly offset: number;
  readonly limit: number;
  /** How many chunks the rows were stored in. */
  readonly chunks: number;
  /** Until when it may be downloaded (by the app's Clock). */
  readonly expiresAt: Date;
}

export interface StoredResult {
  readonly header: ResultHeader;
  /** The rows, chunk after chunk, read one at a time. */
  chunks(): AsyncIterable<StoredRows>;
}

/**
 * Where truth-table jobs keep their rows, bit-packed (packed-rows.ts), in numbered chunks written
 * as they are computed. Bound by RedisModule to Redis, or to this process's memory.
 *
 * Results are temporary by nature: they are kept for 24 hours, and can always be computed again
 * from the circuit. A store with built-in expiry suits them, and keeps PostgreSQL for data that
 * must last. At a much larger scale they would move to object storage (S3), behind this same class.
 */
export abstract class JobResults {
  /** Keeps one chunk of a result still being computed. Chunks are numbered from 0, in row order. */
  abstract append(jobId: string, index: number, rows: StoredRows): Promise<void>;

  /** Completes a result: from now on `open` finds it, until `header.expiresAt`. */
  abstract finish(jobId: string, header: ResultHeader): Promise<void>;

  /** A finished result, or undefined: never finished, expired, or deleted. */
  abstract open(jobId: string): Promise<StoredResult | undefined>;

  abstract delete(jobId: string): Promise<void>;
}
