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
}

/**
 * A Prisma Client for PostgreSQL. Prisma 7 talks to the database through a driver adapter; this
 * one uses node-postgres (`pg`) and its connection pool.
 */
export function createPrismaClient(url: string, options: DatabaseOptions = {}): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: options.poolSize ?? 10 }) });
}

export { expectedMigrations, pendingMigrations } from "./migrations";
