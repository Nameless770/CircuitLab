import { Module, type DynamicModule } from "@nestjs/common";
import { AppConfig } from "./app-config";

/**
 * Makes the one AppConfig available to every module. A dynamic module, because the value is
 * decided when the app is created (from the environment, or passed in by a test or demo).
 */
@Module({})
export class ConfigModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      global: true,
      providers: [{ provide: AppConfig, useValue: config }],
      exports: [AppConfig],
    };
  }
}
