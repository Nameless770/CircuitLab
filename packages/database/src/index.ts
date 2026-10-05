// The database package: the schema (prisma/), its migrations, and a ready-made Prisma Client.
// The rest of the code base imports Prisma from here and never from the generated folder.

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export { CircuitVisibility, GateType, Prisma, PrismaClient, RunKind, RunStatus, ShareRole, SimulationMode } from "./generated/prisma/client";
export type {
  Circuit as CircuitRow,
  CircuitShare as CircuitShareRow,
  Gate as GateRow,
  Session as SessionRow,
  SimulationRun as SimulationRunRow,
  User as UserRow,
  Wire as WireRow,
} from "./generated/prisma/client";

export interface DatabaseOptions {
  /** Most connections to keep open at once. Default 10. */
  readonly poolSize?: number;
  /**
   * How long a query waits for a free connection before it fails, in milliseconds. Default 5,000; 0
   * waits for ever. The pool starts its timer only when this is set, so without it a request with
   * no free connection waits as long as it takes, and a busy database turns into requests piling up
   * instead of the quick, clear 503 that a limit gives (docs/system-design.md measured this).
   */
  readonly connectionTimeoutMs?: number;
}

/**
 * A Prisma Client for PostgreSQL. Prisma 7 talks to the database through a driver adapter; this
 * one uses node-postgres (`pg`) and its connection pool.
 */
export function createPrismaClient(url: string, options: DatabaseOptions = {}): PrismaClient {
  const adapter = new PrismaPg({ connectionString: url, max: options.poolSize ?? 10, connectionTimeoutMillis: options.connectionTimeoutMs ?? 5_000 });
  return new PrismaClient({ adapter });
}

export { expectedMigrations, pendingMigrations } from "./migrations";
