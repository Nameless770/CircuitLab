import { Module, type DynamicModule, type Provider } from "@nestjs/common";
import { SessionsRepository } from "../auth/sessions.repository";
import { UsersRepository } from "../auth/users.repository";
import { CircuitsRepository } from "../circuits/circuits.repository";
import { SharesRepository } from "../circuits/shares.repository";
import { AppConfig } from "../config/app-config";
import { JobsRepository } from "../jobs/jobs.repository";
import { RunsRepository } from "../simulation/runs.repository";
import { InMemoryCircuitsRepository } from "./in-memory-circuits.repository";
import { InMemoryJobsRepository } from "./in-memory-jobs.repository";
import { InMemoryRunsRepository } from "./in-memory-runs.repository";
import { InMemorySessionsRepository } from "./in-memory-sessions.repository";
import { InMemorySharesRepository } from "./in-memory-shares.repository";
import { InMemoryUsersRepository } from "./in-memory-users.repository";
import { PrismaCircuitsRepository } from "./prisma-circuits.repository";
import { PrismaJobsRepository } from "./prisma-jobs.repository";
import { PrismaRunsRepository } from "./prisma-runs.repository";
import { PrismaSessionsRepository } from "./prisma-sessions.repository";
import { PrismaSharesRepository } from "./prisma-shares.repository";
import { PrismaUsersRepository } from "./prisma-users.repository";
import { PrismaService } from "./prisma.service";

/** The abstract repositories the rest of the app depends on. */
const TOKENS = [CircuitsRepository, RunsRepository, JobsRepository, UsersRepository, SessionsRepository, SharesRepository];

/**
 * The one place that decides where data lives. With DATABASE_URL set, the repositories are the
 * PostgreSQL ones (through Prisma); without it, in-memory ones that follow the same rules. The
 * rest of the app only ever sees the abstract repositories.
 *
 * The in-memory circuits need the in-memory users and shares (to join to them, as the SQL does),
 * and the in-memory run history needs the in-memory jobs (in SQL, both are simulation_runs), so
 * those are registered under their own class too, and the abstract tokens point at the same
 * instances (useExisting).
 */
@Module({})
export class StorageModule {
  static forRoot(config: AppConfig): DynamicModule {
    const providers: Provider[] =
      config.databaseUrl === undefined
        ? [
            InMemoryUsersRepository,
            InMemorySharesRepository,
            InMemoryJobsRepository,
            { provide: UsersRepository, useExisting: InMemoryUsersRepository },
            { provide: SharesRepository, useExisting: InMemorySharesRepository },
            { provide: CircuitsRepository, useClass: InMemoryCircuitsRepository },
            { provide: RunsRepository, useClass: InMemoryRunsRepository },
            { provide: JobsRepository, useExisting: InMemoryJobsRepository },
            { provide: SessionsRepository, useClass: InMemorySessionsRepository },
          ]
        : [
            PrismaService,
            { provide: CircuitsRepository, useClass: PrismaCircuitsRepository },
            { provide: RunsRepository, useClass: PrismaRunsRepository },
            { provide: JobsRepository, useClass: PrismaJobsRepository },
            { provide: UsersRepository, useClass: PrismaUsersRepository },
            { provide: SessionsRepository, useClass: PrismaSessionsRepository },
            { provide: SharesRepository, useClass: PrismaSharesRepository },
          ];
    return {
      module: StorageModule,
      global: true,
      providers,
      exports: [...TOKENS, ...(config.databaseUrl === undefined ? [] : [PrismaService])],
    };
  }
}
