/**
 * A cache of computed results: text under string keys. Bound by RedisModule to Redis, or to this
 * process's memory.
 *
 * What goes in is a pure function of its key: the key holds the circuit's id and version, and a
 * version is never reused (every change makes a new one). So an entry can never be out of date,
 * and nothing ever has to be removed when a circuit changes: requests for the new version simply
 * use new keys, and old entries expire (CACHE_TTL_SECONDS) or are evicted when memory is short.
 */
export abstract class ResultCache {
  abstract get(key: string): Promise<string | undefined>;

  /** Keeps the value for the configured time. False when nothing was kept (caching is off). */
  abstract set(key: string, value: string): Promise<boolean>;
}
