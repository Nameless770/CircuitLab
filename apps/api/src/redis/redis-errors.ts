/** What the Redis client and BullMQ throw when Redis is down, unreachable, or full. */
const UNAVAILABLE_NAMES = new Set(["MaxRetriesPerRequestError", "ConnectionClosedError", "ClusterAllFailedError"]);
const UNAVAILABLE_MESSAGES = new Set([
  "Stream isn't writeable and enableOfflineQueue options is false", // disconnected, and commands aren't queued
  "Command timed out", // connected, but Redis didn't answer (hung, or overloaded)
  "Connection is closed.",
]);
/**
 * Redis's own error replies that mean "not now" rather than "wrong": still loading its data after
 * a restart, a replica without its primary, or out of memory (the queue's Redis never evicts, so
 * when it is full, writes are refused).
 */
const UNAVAILABLE_REPLIES = /^(LOADING|MASTERDOWN|OOM|TRYAGAIN) /;

/** Network errors, which a client meets while it can't reach Redis and keeps trying. */
const CONNECTION_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENOTFOUND", "EPIPE"]);

/**
 * True for the errors a Redis client reports while it can't reach Redis. RedisService reports an
 * outage once; the clients' own reports, one per reconnection attempt, add nothing.
 */
export function isConnectionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return isRedisUnavailable(error) || (typeof code === "string" && CONNECTION_CODES.has(code));
}

/**
 * True when an error means Redis can't serve requests right now: worth a 503 and a retry, unlike
 * a bug. The Redis counterpart of isDatabaseUnavailable.
 */
export function isRedisUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return UNAVAILABLE_NAMES.has(error.name) || UNAVAILABLE_MESSAGES.has(error.message) || UNAVAILABLE_REPLIES.test(error.message);
}
