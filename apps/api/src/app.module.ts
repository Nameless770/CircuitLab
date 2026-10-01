import { Module, type DynamicModule } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module";
import { CircuitsModule } from "./circuits/circuits.module";
import { ProblemFilter } from "./common/problem.filter";
import { AppConfig } from "./config/app-config";
import { ConfigModule } from "./config/config.module";
import { HealthModule } from "./health/health.controller";
import { SimulationModule } from "./simulation/simulation.module";
import { StorageModule } from "./storage/storage.module";

/**
 * The whole application:
 *
 *   ConfigModule      AppConfig for everyone (global)
 *   StorageModule     every repository: PostgreSQL or memory (global)
 *   AuthModule        /v1/auth, /v1/users   AuthService; AuthenticationGuard checks every request's token
 *   CircuitsModule    /v1/circuits          CircuitsService (who may do what) -> CircuitsRepository; sharing
 *   SimulationModule  /v1/circuits/{id}/... SimulationService -> CircuitsService, SimulationPoolService
 *   HealthModule      /health               -> SimulationPoolService
 *
 * plus ProblemFilter, through which every error leaves the API.
 */
@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [ConfigModule.forRoot(config), StorageModule.forRoot(config), AuthModule, CircuitsModule, SimulationModule, HealthModule],
      providers: [{ provide: APP_FILTER, useClass: ProblemFilter }],
    };
  }
}
