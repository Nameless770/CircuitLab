import { createPrismaClient, expectedMigrations, pendingMigrations, type PrismaClient } from "@circuitlab/database";
import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { AppConfig } from "../config/app-config";
import { StartupError } from "../config/startup-error";
import { isDatabaseUnavailable } from "./database-errors";

/** The app's one Prisma Client (and so its one connection pool), with its lifecycle tied to the app's. */
@Injectable()
export class PrismaService implements OnModuleInit, OnApplicationShutdown {
  readonly client: PrismaClient;
  private readonly logger = new Logger("Database");
  /** Where the database is, for messages; never includes the password. */
  private readonly location: string;

  constructor(config: AppConfig) {
    if (config.databaseUrl === undefined) throw new Error("PrismaService needs DATABASE_URL");
    this.client = createPrismaClient(config.databaseUrl, { poolSize: config.databasePoolSize });
    const url = new URL(config.databaseUrl);
    this.location = `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  }

  /**
   * Fails at startup, with a clear message, if the database can't be reached or lacks a migration
   * this code needs: better than failing on the first request that touches the missing table.
   */
  async onModuleInit(): Promise<void> {
    let pending: string[];
    try {
      pending = await pendingMigrations(this.client);
    } catch (error) {
      throw new StartupError(
        isDatabaseUnavailable(error)
          ? `Cannot reach the database at ${this.location}. Is it running? (The local one starts with: npm run db:start)`
          : `Cannot use the database at ${this.location}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (pending.length === expectedMigrations().length) {
      throw new StartupError(`The database at ${this.location} has no CircuitLab tables yet. Apply the migrations: npm run db:migrate`);
    }
    if (pending.length > 0) {
      throw new StartupError(
        `The database at ${this.location} is missing ${pending.length === 1 ? "a migration" : `${pending.length} migrations`} ` +
          `this version needs (${pending.join(", ")}). Apply ${pending.length === 1 ? "it" : "them"}: npm run db:migrate`,
      );
    }
    this.logger.log(`Using PostgreSQL at ${this.location}`);
  }

  async isReachable(): Promise<boolean> {
    try {
      await this.client.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.$disconnect();
  }
}
