import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { SessionsRepository } from "../auth/sessions.repository";
import { Clock } from "../common/clock";
import { JobsRepository } from "./jobs.repository";

/** How often housekeeping runs. */
export const HOUSEKEEPING_EVERY_MS = 10 * 60 * 1000;
/** A job still unfinished this long after it was started has been lost. */
const ABANDONED_AFTER_MS = 60 * 60 * 1000;

/**
 * Cleaning up after things that end on their own: sessions past their expiry (phase 7 left them
 * for this), and jobs that were lost, say because their worker's machine died and Redis lost the
 * job too. Without this, a lost job would say "running" forever, and count against its owner's
 * allowance.
 *
 * With Redis, a BullMQ job scheduler runs it every 10 minutes, once for all API instances and
 * workers together (BullMqJobWorkers); without, a timer in this process does (HousekeepingTimer).
 */
@Injectable()
export class Housekeeping {
  private readonly logger = new Logger(Housekeeping.name);

  constructor(
    private readonly sessions: SessionsRepository,
    private readonly jobs: JobsRepository,
    private readonly clock: Clock,
  ) {}

  async run(): Promise<{ readonly expiredSessions: number; readonly abandonedJobs: number }> {
    const now = this.clock.now();
    const expiredSessions = await this.sessions.deleteExpired(now);
    const abandonedJobs = (await this.jobs.failAbandoned(now, new Date(now.getTime() - ABANDONED_AFTER_MS))).length;
    if (expiredSessions + abandonedJobs > 0) {
      this.logger.log(`Housekeeping: deleted ${expiredSessions} expired sessions, failed ${abandonedJobs} abandoned jobs`);
    }
    return { expiredSessions, abandonedJobs };
  }
}

/** Runs housekeeping on a timer, for a single process without Redis. */
@Injectable()
export class HousekeepingTimer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(Housekeeping.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly housekeeping: Housekeeping) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.housekeeping.run().catch((error: unknown) => this.logger.warn(`Housekeeping failed: ${error instanceof Error ? error.message : String(error)}`));
    }, HOUSEKEEPING_EVERY_MS);
    this.timer.unref(); // never keeps the process alive on its own
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
  }
}
