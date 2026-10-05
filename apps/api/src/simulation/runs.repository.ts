import type { RunRecord } from "@circuitlab/api-contract";
import type { Bit, SimulationMode } from "@circuitlab/engine";

/** A finished simulation, about to be recorded. */
export interface NewRun {
  readonly circuitId: string;
  readonly circuitVersion: number;
  /** Who ran it; null when signed out (public circuits can be simulated by anyone). */
  readonly userId: string | null;
  readonly mode: SimulationMode;
  /** The input values as sent, limited to the circuit's own inputs. */
  readonly inputs: Readonly<Record<string, unknown>>;
  /** Its outputs when it succeeded, or the problem code the API answered with when it failed. */
  readonly outcome: { readonly outputs: Readonly<Record<string, Bit>> } | { readonly errorCode: string };
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

/** The history of simulations. Bound like CircuitsRepository: PostgreSQL or memory. */
export abstract class RunsRepository {
  abstract record(run: NewRun): Promise<void>;

  /** A circuit's most recent runs, newest first: everyone's, or only `userId`'s. */
  abstract recent(circuitId: string, limit: number, userId?: string): Promise<readonly RunRecord[]>;

  /**
   * Retention: deletes up to `limit` runs created before `cutoff`, simulations and truth-table
   * jobs, the oldest first, and says how many. Housekeeping repeats it until a batch comes back
   * short. A run that is still queued or running is never deleted (queries.sql: delete_old_runs).
   */
  abstract deleteFinishedBefore(cutoff: Date, limit: number): Promise<number>;
}
