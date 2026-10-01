// Authentication and authorization in the contract's terms: the errors, with the headers HTTP
// requires, and the rules for reading credentials. Framework-free, like the rest of the contract.

import { LIMITS } from "./limits";
import { ApiError } from "./problems";

/**
 * Every 401 says how to authenticate (RFC 9110 requires a WWW-Authenticate header with it). The
 * scheme is RFC 6750's Bearer: `Authorization: Bearer <access token>`.
 */
const CHALLENGE = 'Bearer realm="circuitlab"';

/** 401: the request needs a signed-in user and came without a token. */
export function unauthenticated(detail = "Sign in first, then send the access token: Authorization: Bearer <token>."): ApiError {
  return new ApiError("unauthenticated", detail, { headers: { "WWW-Authenticate": CHALLENGE } });
}

/**
 * 401: a token that can't be used (malformed, forged, expired, or a refresh token that has been
 * replaced or revoked). The client should refresh, or sign in again. `error="invalid_token"` is
 * RFC 6750's code for it, so standard clients know what happened.
 */
export function invalidToken(detail: string): ApiError {
  return new ApiError("invalid-token", detail, { headers: { "WWW-Authenticate": `${CHALLENGE}, error="invalid_token"` } });
}

/**
 * 401 for a failed sign-in. One answer for "no such account" and "wrong password", so the API
 * doesn't tell strangers which email addresses have accounts.
 */
export function invalidCredentials(): ApiError {
  return new ApiError("invalid-credentials", "The email address or the password is wrong.", { headers: { "WWW-Authenticate": CHALLENGE } });
}

/**
 * 403: the caller can see the circuit but may not do this to it (a viewer editing, an editor
 * deleting). Someone who can't see a circuit at all gets 404 instead, so private circuits can't be
 * found by guessing ids.
 */
export function forbidden(detail: string): ApiError {
  return new ApiError("forbidden", detail);
}

export function emailTaken(): ApiError {
  return new ApiError("email-taken", "An account with this email address already exists. Sign in instead.");
}

/** 429 after too many failed sign-ins for one account from one address. */
export function tooManySignInAttempts(retryAfterSeconds: number): ApiError {
  return new ApiError("too-many-requests", `Too many failed sign-ins. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`, {
    headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  });
}

/**
 * The token in an `Authorization: Bearer <token>` header.
 * @throws ApiError `invalid-token` (401) for any other scheme or shape
 */
export function bearerToken(header: string): string {
  const match = /^Bearer +([A-Za-z0-9\-._~+/]+=*) *$/i.exec(header);
  if (match?.[1] === undefined) throw invalidToken('The Authorization header must be "Bearer <access token>".');
  return match[1];
}

/** Email addresses are compared in lower case: one account per address, however it is typed. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Passwords are hashed in Unicode normal form NFKC, as NIST SP 800-63B recommends, so the same
 * passphrase typed on two keyboards (composed "é" or "e" plus an accent) is the same password.
 */
export function normalizePassword(password: string): string {
  return password.normalize("NFKC");
}

/** Seconds until a new session ends if it isn't refreshed. */
export const SESSION_SECONDS = LIMITS.sessionDays * 24 * 60 * 60;
