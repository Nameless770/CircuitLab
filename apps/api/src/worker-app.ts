import "reflect-metadata";
import { Module, type DynamicModule, type INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { CreateAppOptions } from "./app";
import { SystemClock, type Clock } from "./common/clock";
import { AppConfig } from "./config/app-config";
import { ConfigModule } from "./config/config.module";
import { JobsModule } from "./jobs/jobs.module";
import { RedisModule } from "./redis/redis.module";
import { StorageModule } from "./storage/storage.module";

/**
 * A worker process: the job workers, without HTTP. It shares the API's storage, Redis, and job
 * code, and takes truth-table jobs from the BullMQ queue that API instances fill. Running workers
 * separately lets the two scale apart: heavy tables never slow down the API's answers, and more
 * workers can be added when the queue grows (phase 11 runs them as their own container).
 */
@Module({})
class WorkerModule {
  static register(config: AppConfig, clock: Clock): DynamicModule {
    return {
      module: WorkerModule,
      imports: [ConfigModule.forRoot(config, clock), StorageModule.forRoot(config), RedisModule.forRoot(config), JobsModule.forRoot(config, "worker")],
    };
  }
}

/** Builds a started worker: it takes jobs from Redis until closed (or sent SIGTERM / SIGINT). */
export async function createWorker(options: CreateAppOptions = {}): Promise<INestApplicationContext> {
  const config = options.config ?? AppConfig.fromEnvironment();
  const worker = await NestFactory.createApplicationContext(WorkerModule.register(config, options.clock ?? new SystemClock()), {
    ...(options.logLevels !== undefined && { logger: options.logLevels }),
  });
  worker.enableShutdownHooks();
  return worker;
}
