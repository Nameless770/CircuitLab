import { createHash, randomBytes } from "node:crypto";

// A refresh token is "<session id>.<secret>": the id finds the session, and the secret proves the
// holder was given it. The secret is 32 random bytes (256 bits), so it can't be guessed, and the
// database keeps only its SHA-256 hash. A fast hash is enough here, unlike for passwords: hashing
// slowly protects guessable secrets, and a random 256-bit secret isn't one.

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/; // 32 bytes in base64url

export function newSecret(): Buffer {
  return randomBytes(32);
}

export function hashSecret(secret: Buffer): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function formatRefreshToken(sessionId: string, secret: Buffer): string {
  return `${sessionId}.${secret.toString("base64url")}`;
}

/** The parts of a refresh token, or undefined for anything that isn't one. */
export function parseRefreshToken(token: string): { readonly sessionId: string; readonly secret: Buffer } | undefined {
  const [sessionId = "", secret = "", ...rest] = token.split(".");
  if (rest.length > 0 || !SESSION_ID.test(sessionId) || !SECRET.test(secret)) return undefined;
  return { sessionId, secret: Buffer.from(secret, "base64url") };
}
