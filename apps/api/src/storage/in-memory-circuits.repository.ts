import { randomUUID } from "node:crypto";
import { compareCircuits, isAfterCursor } from "@circuitlab/api-contract";
import type { CircuitHeader, CircuitMetadataPatch, CircuitRecord } from "@circuitlab/api-contract";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { AccessFacts } from "../circuits/circuit-access";
import { CircuitsRepository, type CircuitDraft, type CircuitQuery } from "../circuits/circuits.repository";
import { Clock } from "../common/clock";
import { InMemorySharesRepository } from "./in-memory-shares.repository";
import { InMemoryUsersRepository } from "./in-memory-users.repository";

/**
 * Keeps circuits in a Map: used when no DATABASE_URL is set (demos, quick experiments, tests).
 * Everything is lost when the process stops. It follows the same rules as the database: list order
 * and cursors from the contract, the same three list scopes, optimistic locking on every write, and
 * stored copies that callers can't change behind its back.
 */
@Injectable()
export class InMemoryCircuitsRepository extends CircuitsRepository implements OnModuleInit {
  private readonly circuits = new Map<string, CircuitRecord>();

  constructor(
    private readonly users: InMemoryUsersRepository,
    private readonly shares: InMemorySharesRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  onModuleInit(): void {
    new Logger("Storage").log("No DATABASE_URL set: accounts and circuits are kept in memory and lost when the API stops");
  }

  async list({ limit, sort, scope, userId, cursor, q }: CircuitQuery): Promise<readonly CircuitHeader[]> {
    const inScope = (circuit: CircuitRecord): boolean => {
      switch (scope) {
        case "owned":
          return circuit.owner.id === userId;
        case "shared":
          return userId !== undefined && this.shares.roleOf(circuit.id, userId) !== undefined;
        case "public":
          return circuit.visibility === "public";
      }
    };
    const needle = q?.toLowerCase();
    return [...this.circuits.values()]
      .filter(inScope)
      .filter((circuit) => needle === undefined || circuit.name.toLowerCase().includes(needle))
      .filter((circuit) => cursor === undefined || isAfterCursor(circuit, cursor))
      .sort(compareCircuits(sort))
      .slice(0, limit);
  }

  async find(id: string): Promise<CircuitRecord | undefined> {
    return this.circuits.get(id);
  }

  async accessFacts(id: string, userId: string | undefined): Promise<AccessFacts | undefined> {
    const circuit = this.circuits.get(id);
    if (circuit === undefined) return undefined;
    return {
      ownerId: circuit.owner.id,
      visibility: circuit.visibility,
      version: circuit.version,
      sharedRole: userId === undefined ? undefined : this.shares.roleOf(id, userId),
    };
  }

  async create(draft: CircuitDraft, ownerId: string): Promise<CircuitRecord> {
    const owner = this.users.summary(ownerId);
    if (owner === undefined) throw new Error(`No user ${ownerId}`); // the foreign key, in SQL
    const now = this.clock.now();
    const record: CircuitRecord = Object.freeze({
      id: randomUUID(),
      owner: { id: owner.id, displayName: owner.displayName },
      visibility: "private",
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...content(draft),
    });
    this.circuits.set(record.id, record);
    return record;
  }

  async replace(id: string, draft: CircuitDraft, expectedVersion?: number): Promise<CircuitRecord | undefined> {
    return this.update(id, expectedVersion, content(draft));
  }

  async updateMetadata(id: string, patch: CircuitMetadataPatch, expectedVersion?: number): Promise<CircuitRecord | undefined> {
    return this.update(id, expectedVersion, {
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.visibility !== undefined && { visibility: patch.visibility }),
    });
  }

  async delete(id: string, expectedVersion?: number): Promise<boolean> {
    const current = this.circuits.get(id);
    if (current === undefined || (expectedVersion !== undefined && current.version !== expectedVersion)) return false;
    this.shares.forgetCircuit(id);
    return this.circuits.delete(id);
  }

  private update(id: string, expectedVersion: number | undefined, changes: Partial<CircuitRecord>): CircuitRecord | undefined {
    const current = this.circuits.get(id);
    if (current === undefined || (expectedVersion !== undefined && current.version !== expectedVersion)) return undefined;
    const next: CircuitRecord = Object.freeze({ ...current, ...changes, version: current.version + 1, updatedAt: this.clock.now() });
    this.circuits.set(id, next);
    return next;
  }
}

/** The stored part of a circuit, copied so that later changes to the request body can't reach it. */
function content(draft: CircuitDraft): Pick<CircuitRecord, "name" | "description" | "summary" | "gates" | "wires"> {
  return {
    name: draft.name,
    description: draft.description ?? null,
    summary: structuredClone(draft.summary),
    gates: structuredClone(draft.gates),
    wires: structuredClone(draft.wires),
  };
}
