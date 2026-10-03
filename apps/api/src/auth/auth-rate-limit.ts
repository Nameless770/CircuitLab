/** The window the count is kept in. */
export const AUTH_RATE_WINDOW_SECONDS = 60;

/**
 * Limits how many password hashes one address may ask for. Registering and signing in both cost a
 * full Argon2 hash (about 28 ms of CPU: a container with 2 CPUs manages some 50 a second, and while
 * it hashes, nothing else gets the CPUs; see docs/system-design.md). The sign-in throttle only
 * counts failures per account and address, so a client that makes up email addresses is never
 * stopped by it, and registration has no throttle at all.
 *
 * This counts every attempt, successful or not, per address, in a one-minute window. It is off
 * unless AUTH_RATE_LIMIT is set (and behind a proxy it needs TRUST_PROXY too, or every client
 * looks like the proxy).
 *
 * Bound by RedisModule, like the throttle: in Redis the count is shared by every API instance,
 * and without REDIS_URL it is kept in this process's memory. Either way the time comes from the
 * injected Clock.
 */
export abstract class AuthRateLimit {
  /**
   * Counts one attempt by `address`.
   * @throws ApiError `too-many-requests` (429) once the address is over the limit for this minute
   */
  abstract hit(address: string): Promise<void>;
}
