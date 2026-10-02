/**
 * Sign-in sessions, one per signed-in device. Each holds the hash of the current secret of its
 * refresh token (see refresh-tokens.ts), never the secret itself.
 */
export abstract class SessionsRepository {
  /** Starts a session; returns its id. */
  abstract create(userId: string, secretHash: Buffer, now: Date, expiresAt: Date): Promise<string>;

  /**
   * Replaces the secret, but only if `secretHash` is the current one and the session hasn't
   * expired (an atomic compare-and-swap). Returns the session's user id, or undefined if nothing
   * was replaced.
   */
  abstract rotate(sessionId: string, secretHash: Buffer, newSecretHash: Buffer, now: Date, expiresAt: Date): Promise<string | undefined>;

  abstract delete(sessionId: string): Promise<void>;

  /** Housekeeping: deletes every session that expired by `now`. Returns how many. */
  abstract deleteExpired(now: Date): Promise<number>;
}
