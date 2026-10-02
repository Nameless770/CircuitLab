import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { Queue } from "bullmq";
import { isConnectionError } from "../redis/redis-errors";
import { RedisService } from "../redis/redis.service";
import { JobQueue, TRUTH_TABLE_QUEUE } from "./job-queue";

/** What a BullMQ job carries: only the id. The job itself is in JobsRepository. */
export interface TruthTableJobData {
  readonly jobId: string;
}

function truthTableQueue(redis: RedisService) {
  return new Queue<TruthTableJobData>(TRUTH_TABLE_QUEUE, {
    connection: redis.bullConnection("queue"),
    prefix: redis.bullPrefix,
    defaultJobOptions: {
      // A database or Redis outage, or a worker stopped mid-job, is worth retrying: 1, then 2
      // seconds later. A job that can't succeed (PermanentJobError) is not retried at all.
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      // BullMQ's own records of finished jobs. JobsRepository keeps the history that matters.
      removeOnComplete: { age: 24 * 60 * 60 },
      removeOnFail: { age: 7 * 24 * 60 * 60 },
    },
  });
}

/**
 * The job queue in Redis, through BullMQ: the producer half, which API instances use to hand jobs
 * over. Any worker process (BullMqJobWorkers) may take them, and they survive a restart.
 *
 * BullMQ's job id is the job's own id, so adding the same job twice is harmless (BullMQ keeps the
 * first), and its progress can be looked up by that id from any process.
 */
@Injectable()
export class BullMqJobQueue extends JobQueue implements OnApplicationShutdown {
  private readonly queue: ReturnType<typeof truthTableQueue>;

  constructor(redis: RedisService) {
    super();
    this.queue = truthTableQueue(redis);
    const logger = new Logger("Jobs");
    // Outages are reported once, by RedisService; anything else is worth a line.
    this.queue.on("error", (error) => {
      if (!isConnectionError(error)) logger.warn(`BullMQ: ${error.message}`);
    });
  }

  async add(jobId: string): Promise<void> {
    await this.queue.add("truth-table", { jobId }, { jobId });
  }

  async rowsDone(jobId: string): Promise<number> {
    const progress = (await this.queue.getJob(jobId))?.progress;
    return typeof progress === "number" ? progress : 0;
  }

  async remove(jobId: string): Promise<void> {
    await this.queue.remove(jobId); // 0 (and no harm) when a worker has it already
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close();
  }
}
