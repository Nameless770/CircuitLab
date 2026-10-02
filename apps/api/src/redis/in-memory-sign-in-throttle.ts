import { LIMITS, tooManySignInAttempts } from "@circuitlab/api-contract";
import { Injectable } from "@nestjs/common";
import { SignInThrottle } from "../auth/sign-in-throttle";
import { Clock } from "../common/clock";

/** Entries kept at most; beyond that the oldest are dropped, so the map can't grow without bound. */
const MAX_ENTRIES = 100_000;
const PRUNE_TO = MAX_ENTRIES * 0.9;

/** The throttle in a Map: one process only, and forgotten on restart. */
@Injectable()
export class InMemorySignInThrottle extends SignInThrottle {
  private readonly failures = new Map<string, { count: number; readonly since: number }>();

  constructor(private readonly clock: Clock) {
    super();
  }

  async check(key: string): Promise<void> {
    const now = this.clock.now().getTime();
    const entry = this.current(key, now);
    if (entry !== undefined && entry.count >= LIMITS.signIn.maxFailures) {
      throw tooManySignInAttempts((entry.since + LIMITS.signIn.windowSeconds * 1000 - now) / 1000);
    }
  }

  async failed(key: string): Promise<void> {
    const now = this.clock.now().getTime();
    const entry = this.current(key, now);
    if (entry !== undefined) {
      entry.count++;
      return;
    }
    this.failures.set(key, { count: 1, since: now });
    if (this.failures.size > MAX_ENTRIES) this.prune(now);
  }

  async succeeded(key: string): Promise<void> {
    this.failures.delete(key);
  }

  private current(key: string, now: number): { count: number; readonly since: number } | undefined {
    const entry = this.failures.get(key);
    if (entry !== undefined && now - entry.since >= LIMITS.signIn.windowSeconds * 1000) {
      this.failures.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * Drops expired entries, then, if there are still too many, the oldest ones (a Map iterates in
   * insertion order) down to 90% of the limit. Pruning reads the whole map, so it must not happen on
   * every failure once the map is full: with that headroom it runs once per 10,000 new keys, which
   * keeps each failure cheap however many addresses an attacker makes up.
   */
  private prune(now: number): void {
    for (const [key] of this.failures) this.current(key, now);
    for (const [key] of this.failures) {
      if (this.failures.size <= PRUNE_TO) break;
      this.failures.delete(key);
    }
  }
}
