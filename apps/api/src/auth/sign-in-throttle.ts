/**
 * Limits password guessing: after 5 failed sign-ins for one account from one IP address, that
 * pair gets 429 until 15 minutes after its first failure. Keyed by account *and* address, so an
 * attacker can't lock someone out of their account by failing sign-ins for it from elsewhere.
 *
 * Bound by RedisModule. In Redis (phase 10) the count is shared by every API instance, so
 * spreading guesses over several instances doesn't multiply them; without REDIS_URL it is kept in
 * this process's memory. Either way the time comes from the injected Clock.
 */
export abstract class SignInThrottle {
  /** @throws ApiError `too-many-requests` (429) while the key is blocked */
  abstract check(key: string): Promise<void>;

  abstract failed(key: string): Promise<void>;

  /** A successful sign-in forgets the key's failures. */
  abstract succeeded(key: string): Promise<void>;
}
