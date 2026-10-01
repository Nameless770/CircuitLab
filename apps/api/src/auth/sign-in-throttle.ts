import { LIMITS, tooManySignInAttempts } from "@circuitlab/api-contract";
import { Injectable } from "@nestjs/common";

/** Entries kept at most; beyond that the oldest are dropped, so the map can't grow without bound. */
const MAX_ENTRIES = 100_000;
const PRUNE_TO = MAX_ENTRIES * 0.9;

/**
 * Limits password guessing: after 5 failed sign-ins for one account from one IP address, that
 * pair gets 429 until 15 minutes after its first failure. Keyed by account *and* address, so an
 * attacker can't lock someone out of their account by failing sign-ins for it from elsewhere.
 *
 * Kept in memory, so it is per process and forgotten on restart. Phase 10 moves rate limits to
 * Redis, shared by every API instance.
 */
@Injectable()
export class SignInThrottle {
  private readonly failures = new Map<string, { count: number; readonly since: number }>();

  /** @throws ApiError `too-many-requests` (429) while the key is blocked */
  check(key: string, now = Date.now()): void {
    const entry = this.current(key, now);
    if (entry !== undefined && entry.count >= LIMITS.signIn.maxFailures) {
      throw tooManySignInAttempts((entry.since + LIMITS.signIn.windowSeconds * 1000 - now) / 1000);
    }
  }

  failed(key: string, now = Date.now()): void {
    const entry = this.current(key, now);
    if (entry !== undefined) {
      entry.count++;
      return;
    }
    this.failures.set(key, { count: 1, since: now });
    if (this.failures.size > MAX_ENTRIES) this.prune(now);
  }

  succeeded(key: string): void {
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
