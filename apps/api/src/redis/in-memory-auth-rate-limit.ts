import { tooManyAuthRequests } from "@circuitlab/api-contract";
import { Injectable } from "@nestjs/common";
import { AUTH_RATE_WINDOW_SECONDS, AuthRateLimit } from "../auth/auth-rate-limit";
import { Clock } from "../common/clock";
import { AppConfig } from "../config/app-config";

const WINDOW_MS = AUTH_RATE_WINDOW_SECONDS * 1000;
/** Addresses kept at most; beyond that the oldest are dropped, so the map can't grow without bound. */
const MAX_ENTRIES = 100_000;
const PRUNE_TO = MAX_ENTRIES * 0.9;

/** The limit in a Map: one process only, and forgotten on restart. */
@Injectable()
export class InMemoryAuthRateLimit extends AuthRateLimit {
  private readonly windows = new Map<string, { count: number; readonly since: number }>();

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {
    super();
  }

  async hit(address: string): Promise<void> {
    const limit = this.config.authRateLimit;
    if (limit === 0) return;
    const now = this.clock.now().getTime();
    let window = this.current(address, now);
    if (window === undefined) {
      window = { count: 0, since: now };
      this.windows.set(address, window);
      if (this.windows.size > MAX_ENTRIES) this.prune(now);
    }
    window.count++;
    if (window.count > limit) throw tooManyAuthRequests((window.since + WINDOW_MS - now) / 1000);
  }

  private current(address: string, now: number): { count: number; readonly since: number } | undefined {
    const window = this.windows.get(address);
    if (window !== undefined && now - window.since >= WINDOW_MS) {
      this.windows.delete(address);
      return undefined;
    }
    return window;
  }

  /** Drops expired windows, then, if there are still too many, the oldest down to 90% of the limit. */
  private prune(now: number): void {
    for (const [address] of this.windows) this.current(address, now);
    for (const [address] of this.windows) {
      if (this.windows.size <= PRUNE_TO) break;
      this.windows.delete(address);
    }
  }
}
