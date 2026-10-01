import { Module, type DynamicModule } from "@nestjs/common";
import { Clock } from "../common/clock";
import { AppConfig } from "./app-config";

/**
 * Makes the app's surroundings available to every module: the one AppConfig, and the Clock. A
 * dynamic module, because both are decided when the app is created (from the environment, or
 * passed in by a test or demo).
 */
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig, clock: Clock): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [
        { provide: AppConfig, useValue: config },
        { provide: Clock, useValue: clock },
      ],
      exports: [AppConfig, Clock],
    };
  }
}
