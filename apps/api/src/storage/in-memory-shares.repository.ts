import type { ShareRecord, ShareRole } from "@circuitlab/api-contract";
import { Injectable } from "@nestjs/common";
import { SharesRepository } from "../circuits/shares.repository";
import { InMemoryUsersRepository } from "./in-memory-users.repository";

interface Share {
  readonly role: ShareRole;
  readonly createdAt: Date;
}

/** Shares in Maps, for when there is no database: circuit id -> user id -> share. */
@Injectable()
export class InMemorySharesRepository extends SharesRepository {
  private readonly byCircuit = new Map<string, Map<string, Share>>();

  constructor(private readonly users: InMemoryUsersRepository) {
    super();
  }

  async list(circuitId: string): Promise<readonly ShareRecord[]> {
    const records: ShareRecord[] = [];
    for (const [userId, share] of this.byCircuit.get(circuitId) ?? []) {
      const user = this.users.summary(userId);
      if (user !== undefined) records.push({ user, role: share.role, createdAt: share.createdAt });
    }
    return records.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.user.id < b.user.id ? -1 : 1));
  }

  async upsert(circuitId: string, userId: string, role: ShareRole): Promise<{ readonly share: ShareRecord; readonly created: boolean }> {
    const user = this.users.summary(userId);
    if (user === undefined) throw new Error(`No user ${userId}`); // the foreign key, in SQL
    const shares = this.byCircuit.get(circuitId) ?? new Map<string, Share>();
    this.byCircuit.set(circuitId, shares);
    const existing = shares.get(userId);
    const share: Share = { role, createdAt: existing?.createdAt ?? new Date() };
    shares.set(userId, share);
    return { share: { user, role, createdAt: share.createdAt }, created: existing === undefined };
  }

  async remove(circuitId: string, userId: string): Promise<boolean> {
    return this.byCircuit.get(circuitId)?.delete(userId) ?? false;
  }

  /** For InMemoryCircuitsRepository: the role a circuit is shared with a user, if it is. */
  roleOf(circuitId: string, userId: string): ShareRole | undefined {
    return this.byCircuit.get(circuitId)?.get(userId)?.role;
  }

  /** Deleting a circuit deletes its shares (ON DELETE CASCADE, in SQL). */
  forgetCircuit(circuitId: string): void {
    this.byCircuit.delete(circuitId);
  }
}
