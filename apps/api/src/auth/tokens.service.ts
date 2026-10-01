import { randomBytes } from "node:crypto";
import { LIMITS, invalidToken } from "@circuitlab/api-contract";
import { Injectable, Logger } from "@nestjs/common";
import { SignJWT, errors, jwtVerify } from "jose";
import { Clock } from "../common/clock";
import { AppConfig } from "../config/app-config";
import type { AuthUser } from "./auth-user";

const ALGORITHM = "HS256";
const ISSUER = "circuitlab";
const AUDIENCE = "circuitlab-api";

/**
 * Access tokens: JWTs signed with HMAC-SHA256 (HS256) and a server-side secret. HS256 suits one
 * service that both issues and checks its tokens; if other services ever need to check them
 * without being able to issue them, an asymmetric algorithm (EdDSA) would replace it.
 *
 * A token says who the user is (`sub`) and until when (`exp`), and nothing else: no roles or
 * permissions, which could go stale for 15 minutes. What someone may do with a circuit is looked up
 * on every request.
 */
@Injectable()
export class TokenService {
  private readonly key: Uint8Array;

  constructor(
    config: AppConfig,
    private readonly clock: Clock,
  ) {
    if (config.jwtSecret === undefined) {
      this.key = randomBytes(32);
      new Logger("Auth").warn("No JWT_SECRET set: tokens are signed with a random key and stop working when the API restarts");
    } else {
      this.key = new TextEncoder().encode(config.jwtSecret);
    }
  }

  async issue(userId: string): Promise<{ readonly token: string; readonly expiresIn: number }> {
    const token = await new SignJWT()
      .setProtectedHeader({ alg: ALGORITHM, typ: "JWT" })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      // Both times from the injected Clock, like every other time rule in the app.
      .setIssuedAt(this.clock.now())
      .setExpirationTime(new Date(this.clock.now().getTime() + LIMITS.accessTokenSeconds * 1000))
      .sign(this.key);
    return { token, expiresIn: LIMITS.accessTokenSeconds };
  }

  /**
   * Checks the signature, the algorithm (only HS256: a token claiming `alg: none`, or any other
   * algorithm, is refused before its signature is even considered), the issuer and audience, and
   * the expiry.
   *
   * @throws ApiError `invalid-token` (401)
   */
  async verify(token: string): Promise<AuthUser> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
        requiredClaims: ["sub", "iat", "exp"],
        currentDate: this.clock.now(),
      });
      if (typeof payload.sub !== "string" || payload.sub === "") throw invalidToken("The access token names no user.");
      return { id: payload.sub };
    } catch (error) {
      if (error instanceof errors.JWTExpired) throw invalidToken("The access token has expired. Get a new one from /v1/auth/refresh.");
      if (error instanceof errors.JOSEError) throw invalidToken("The access token is not valid.");
      throw error;
    }
  }
}
