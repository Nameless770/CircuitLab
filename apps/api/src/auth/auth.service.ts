import {
  SESSION_SECONDS,
  authSession,
  emailTaken,
  invalidCredentials,
  invalidToken,
  normalizeEmail,
  userResource,
} from "@circuitlab/api-contract";
import type { AuthSession, RegisterRequest, SignInRequest, UserRecord, UserResource } from "@circuitlab/api-contract";
import { Injectable } from "@nestjs/common";
import { Clock } from "../common/clock";
import type { AuthUser } from "./auth-user";
import { PasswordsService } from "./passwords.service";
import { formatRefreshToken, hashSecret, newSecret, parseRefreshToken } from "./refresh-tokens";
import { SessionsRepository } from "./sessions.repository";
import { SignInThrottle } from "./sign-in-throttle";
import { TokenService } from "./tokens.service";
import { UsersRepository } from "./users.repository";

/**
 * Accounts and sessions. Signing in starts a session and returns two tokens:
 *
 * - an access token (a JWT, 15 minutes), sent with every request and checked without touching the
 *   database;
 * - a refresh token, traded at /auth/refresh for a new pair. Each one works once: refreshing
 *   replaces it. If a replaced one comes back, two parties hold copies of the same session (one of
 *   them probably stole it), and there's no telling which is which, so the session ends.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionsRepository,
    private readonly tokens: TokenService,
    private readonly passwords: PasswordsService,
    private readonly throttle: SignInThrottle,
    private readonly clock: Clock,
  ) {}

  /** @throws ApiError `email-taken` (409) */
  async register(input: RegisterRequest): Promise<AuthSession> {
    const passwordHash = await this.passwords.hash(input.password);
    const user = await this.users.create({ email: normalizeEmail(input.email), displayName: input.displayName.trim(), passwordHash });
    if (user === undefined) throw emailTaken();
    return this.startSession(user);
  }

  /**
   * @param clientAddress the caller's IP address, for the throttle
   * @throws ApiError `invalid-credentials` (401), `too-many-requests` (429)
   */
  async login(input: SignInRequest, clientAddress: string): Promise<AuthSession> {
    const email = normalizeEmail(input.email);
    const throttleKey = `${email} ${clientAddress}`;
    await this.throttle.check(throttleKey);
    const user = await this.users.findByEmail(email);
    // Verified even when there's no such account (against a decoy hash): same work, same timing.
    const valid = await this.passwords.verify(user?.passwordHash, input.password);
    if (user === undefined || !valid) {
      await this.throttle.failed(throttleKey);
      throw invalidCredentials();
    }
    await this.throttle.succeeded(throttleKey);
    if (this.passwords.needsRehash(user.passwordHash)) {
      await this.users.updatePasswordHash(user.id, await this.passwords.hash(input.password));
    }
    return this.startSession(user);
  }

  /** @throws ApiError `invalid-token` (401) */
  async refresh(refreshToken: string): Promise<AuthSession> {
    const parts = parseRefreshToken(refreshToken);
    if (parts === undefined) throw invalidToken("This is not a refresh token from this API.");
    const secret = newSecret();
    const now = this.clock.now();
    const userId = await this.sessions.rotate(parts.sessionId, hashSecret(parts.secret), hashSecret(secret), now, expiry(now));
    if (userId === undefined) {
      // The session is unknown or expired, or its secret was already replaced: a copy of an old
      // token is in use. Ending the session locks out whoever holds a copy, owner and thief alike.
      await this.sessions.delete(parts.sessionId);
      throw invalidToken("The refresh token is no longer valid. Sign in again.");
    }
    const user = await this.users.findById(userId);
    if (user === undefined) throw invalidToken("The account no longer exists.");
    return this.issue(user, parts.sessionId, secret);
  }

  /** Ends the session. Quietly does nothing for a token that isn't one: the result is the same. */
  async logout(refreshToken: string): Promise<void> {
    const parts = parseRefreshToken(refreshToken);
    if (parts !== undefined) await this.sessions.delete(parts.sessionId);
  }

  /** @throws ApiError `invalid-token` (401) if the account has been deleted since the token was issued */
  async me(user: AuthUser): Promise<UserResource> {
    const record = await this.users.findById(user.id);
    if (record === undefined) throw invalidToken("The account no longer exists.");
    return userResource(record);
  }

  private async startSession(user: UserRecord): Promise<AuthSession> {
    const secret = newSecret();
    const now = this.clock.now();
    const sessionId = await this.sessions.create(user.id, hashSecret(secret), now, expiry(now));
    return this.issue(user, sessionId, secret);
  }

  private async issue(user: UserRecord, sessionId: string, secret: Buffer): Promise<AuthSession> {
    const access = await this.tokens.issue(user.id);
    return authSession({ accessToken: access.token, expiresIn: access.expiresIn, refreshToken: formatRefreshToken(sessionId, secret) }, user);
  }
}

/** Sessions slide: each refresh pushes the end 30 days further. */
function expiry(now: Date): Date {
  return new Date(now.getTime() + SESSION_SECONDS * 1000);
}
