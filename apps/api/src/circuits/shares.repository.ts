import type { ShareRecord, ShareRole } from "@circuitlab/api-contract";

/** Who each circuit is shared with. Bound by StorageModule: PostgreSQL or memory. */
export abstract class SharesRepository {
  /** Oldest share first. */
  abstract list(circuitId: string): Promise<readonly ShareRecord[]>;

  /** Shares the circuit with the user, or changes their role if it already is. `created` says which. */
  abstract upsert(circuitId: string, userId: string, role: ShareRole): Promise<{ readonly share: ShareRecord; readonly created: boolean }>;

  /** `false` if the circuit wasn't shared with the user. */
  abstract remove(circuitId: string, userId: string): Promise<boolean>;
}
