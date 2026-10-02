import { Module, type DynamicModule, type Provider } from "@nestjs/common";
import { CircuitsModule } from "../circuits/circuits.module";
import { AppConfig } from "../config/app-config";
import { StartupError } from "../config/startup-error";
import { SimulationModule } from "../simulation/simulation.module";
import { BullMqJobQueue } from "./bullmq-job-queue";
import { BullMqJobWorkers } from "./bullmq-job-workers";
import { Housekeeping, HousekeepingTimer } from "./housekeeping.service";
import { InProcessJobQueue } from "./in-process-job-queue";
import { JobQueue } from "./job-queue";
import { TruthTableJobProcessor } from "./truth-table-job.processor";
import { TruthTableJobsController } from "./truth-table-jobs.controller";
import { TruthTableJobsService } from "./truth-table-jobs.service";

/**
 * Background truth-table jobs (phase 10). Two roles:
 *
 * - "api": the endpoints, and a queue to hand jobs to. With Redis, BullMQ, plus workers of its own
 *   unless JOB_CONCURRENCY is 0; without, a queue inside this process.
 * - "worker": only workers, for a process that does nothing else (worker.ts). Needs Redis: that
 *   is where it finds the jobs.
 *
 * Either way the work itself is TruthTableJobProcessor's, on this process's simulation pool, and
 * the jobs' records come from StorageModule and their results from RedisModule.
 */
@Module({})
export class JobsModule {
  static forRoot(config: AppConfig, role: "api" | "worker"): DynamicModule {
    const redis = config.redisUrl !== undefined;
    if (!redis && role === "worker") throw new StartupError("A worker process needs REDIS_URL: the jobs reach it through Redis.");
    if (!redis && config.jobConcurrency === 0) throw new StartupError("JOB_CONCURRENCY=0 needs REDIS_URL: without Redis, jobs can only run in this process.");
    const work = role === "worker" || config.jobConcurrency > 0;

    const providers: Provider[] = [TruthTableJobProcessor, Housekeeping];
    if (role === "api") providers.push(TruthTableJobsService, { provide: JobQueue, useClass: redis ? BullMqJobQueue : InProcessJobQueue });
    if (redis && work) providers.push(BullMqJobWorkers);
    if (!redis) providers.push(HousekeepingTimer);
    return {
      module: JobsModule,
      imports: [CircuitsModule, SimulationModule],
      controllers: role === "api" ? [TruthTableJobsController] : [],
      providers,
      exports: [Housekeeping],
    };
  }
}
