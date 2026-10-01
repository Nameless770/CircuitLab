import type {
  CircuitCursor,
  CircuitHeader,
  CircuitInput,
  CircuitMetadataPatch,
  CircuitRecord,
  CircuitSort,
  CircuitSummary,
  ListScope,
} from "@circuitlab/api-contract";
import type { AccessFacts } from "./circuit-access";

export interface CircuitQuery {
  /** How many circuits to return at most. */
  readonly limit: number;
  readonly sort: CircuitSort;
  /** Whose circuits: the user's own, those shared with the user, or the public ones. */
  readonly scope: ListScope;
  /** The user `owned` and `shared` refer to. */
  readonly userId: string | undefined;
  /** Only circuits after this one, in `sort` order. */
  readonly cursor?: CircuitCursor;
  /** Only circuits whose name contains this, ignoring case. */
  readonly q?: string;
}

/** A circuit about to be stored: the client's input, plus the summary the engine computed from it. */
export interface CircuitDraft extends CircuitInput {
  readonly summary: CircuitSummary;
}

/**
 * Where circuits are kept. Services depend on this abstraction, never on a storage technology:
 * StorageModule binds it to PostgreSQL through Prisma when DATABASE_URL is set, and to an in-memory
 * implementation otherwise. (An abstract class rather than an interface because Nest needs a
 * runtime value to use as the injection token.)
 *
 * The repository stores and finds; it doesn't decide who may do what (CircuitsService does, with
 * circuit-access.ts), except that lists only ever contain circuits of the requested scope.
 *
 * Writes can use optimistic locking: given the version the caller last saw, they only apply if it
 * is still current, so two concurrent edits can't both win. In SQL that is
 * `UPDATE circuits SET ... WHERE id = $1 AND version = $2`, checking that one row changed. Without
 * an expected version (the client sent no If-Match), the write applies to whatever is current.
 */
export abstract class CircuitsRepository {
  /** Up to `query.limit` circuits of the scope, in list order; see `compareCircuits` and `isAfterCursor` in the contract. */
  abstract list(query: CircuitQuery): Promise<readonly CircuitHeader[]>;

  /** The circuit, or undefined. Circuits stored before accounts existed have no owner and are never found. */
  abstract find(id: string): Promise<CircuitRecord | undefined>;

  /** What deciding access needs, without loading the gates and wires. Undefined like `find`. */
  abstract accessFacts(id: string, userId: string | undefined): Promise<AccessFacts | undefined>;

  /** Stores a new, private circuit at version 1. */
  abstract create(draft: CircuitDraft, ownerId: string): Promise<CircuitRecord>;

  /** Replaces everything but the id and owner. `undefined` if the circuit is gone or is no longer at `expectedVersion`. */
  abstract replace(id: string, draft: CircuitDraft, expectedVersion?: number): Promise<CircuitRecord | undefined>;

  /** Changes the name, description, and/or visibility. `undefined` if the circuit is gone or has moved on. */
  abstract updateMetadata(id: string, patch: CircuitMetadataPatch, expectedVersion?: number): Promise<CircuitRecord | undefined>;

  /** `false` if the circuit is gone or has moved on. */
  abstract delete(id: string, expectedVersion?: number): Promise<boolean>;
}
