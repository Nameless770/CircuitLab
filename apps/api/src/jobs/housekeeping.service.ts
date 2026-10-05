import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { SessionsRepository } from "../auth/sessions.repository";
import { Clock } from "../common/clock";
import { AppConfig } from "../config/app-config";
import { RunsRepository } from "../simulation/runs.repository";
import { JobsRepository } from "./jobs.repository";

/** How often housekeeping runs. */
export const HOUSEKEEPING_EVERY_MS = 10 * 60 * 1000;
/** A job still unfinished this long after it was started has been lost. */
const ABANDONED_AFTER_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Runs deleted in one batch, and batches in one housekeeping run. Deleting in small batches keeps
 * each one quick, so it never holds up the requests that share the database; whatever is left
 * goes in the next run, ten minutes later. 50,000 runs per run is more than the plan's target
 * adds in that time (about 20,000: docs/system-design.md), so it keeps up.
 */
export const RETENTION_BATCH = 1_000;
export const RETENTION_BATCHES_PER_RUN = 50;

/**
 * Cleaning up after things that end on their own: sessions past their expiry (phase 7 left them
 * for this), jobs that were lost, say because their worker's machine died and Redis lost the
 * job too (without this, a lost job would say "running" forever, and count against its owner's
 * allowance), and the history of simulations and jobs, which is kept for RUN_RETENTION_DAYS and
 * would otherwise grow without end.
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
    private readonly runs: RunsRepository,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  async run(): Promise<{ readonly expiredSessions: number; readonly abandonedJobs: number; readonly deletedRuns: number }> {
    const now = this.clock.now();
    const expiredSessions = await this.sessions.deleteExpired(now);
    // Lost jobs first: once failed they are finished, and the retention below can delete them in time.
    const abandonedJobs = (await this.jobs.failAbandoned(now, new Date(now.getTime() - ABANDONED_AFTER_MS))).length;
    const deletedRuns = await this.deleteOldRuns(now);
    if (expiredSessions + abandonedJobs + deletedRuns > 0) {
      this.logger.log(`Housekeeping: deleted ${expiredSessions} expired sessions and ${deletedRuns} old runs, failed ${abandonedJobs} abandoned jobs`);
    }
    return { expiredSessions, abandonedJobs, deletedRuns };
  }

  /** Retention: finished runs older than RUN_RETENTION_DAYS, in batches. 0 days keeps them for ever. */
  private async deleteOldRuns(now: Date): Promise<number> {
    if (this.config.runRetentionDays === 0) return 0;
    const cutoff = new Date(now.getTime() - this.config.runRetentionDays * DAY_MS);
    let deleted = 0;
    for (let batch = 0; batch < RETENTION_BATCHES_PER_RUN; batch++) {
      const count = await this.runs.deleteFinishedBefore(cutoff, RETENTION_BATCH);
      deleted += count;
      if (count < RETENTION_BATCH) break; // the last batch: nothing older is left
    }
    return deleted;
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
