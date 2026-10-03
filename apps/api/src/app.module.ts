import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module";
import { CircuitsModule } from "./circuits/circuits.module";
import type { Clock } from "./common/clock";
import { ProblemFilter } from "./common/problem.filter";
import { AppConfig } from "./config/app-config";
import { ConfigModule } from "./config/config.module";
import { DocsModule } from "./docs/docs.controller";
import { HealthModule } from "./health/health.controller";
import { JobsModule } from "./jobs/jobs.module";
import { RedisModule } from "./redis/redis.module";
import { SimulationModule } from "./simulation/simulation.module";
import { StorageModule } from "./storage/storage.module";

/**
 * The whole application:
 *
 *   ConfigModule      AppConfig and the Clock, for everyone (global)
 *   StorageModule     every repository: PostgreSQL or memory (global)
 *   RedisModule       result cache, sign-in throttle, job results: Redis or memory (global)
 *   AuthModule        /v1/auth, /v1/users   AuthService; AuthenticationGuard checks every request's token
 *   CircuitsModule    /v1/circuits          CircuitsService (who may do what) -> CircuitsRepository; sharing
 *   SimulationModule  /v1/circuits/{id}/... SimulationService -> CircuitsService, SimulationPoolService, ResultCache
 *   JobsModule        .../truth-table/jobs  TruthTableJobsService -> JobQueue (BullMQ or in-process);
 *                                           workers: TruthTableJobProcessor -> SimulationPoolService, JobResults
 *   HealthModule      /health               -> SimulationPoolService, PrismaService, RedisService
 *   DocsModule        /docs, /openapi.json  Swagger UI on the contract; / leads there
 *
 * plus ProblemFilter, through which every error leaves the API.
 */
@Module({})
export class AppModule {
  static register(config: AppConfig, clock: Clock): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forRoot(config, clock),
        StorageModule.forRoot(config),
        RedisModule.forRoot(config),
        AuthModule,
        CircuitsModule,
        SimulationModule,
        JobsModule.forRoot(config, "api"),
        HealthModule,
        DocsModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
    };
  }
}
