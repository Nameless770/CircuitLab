// The app's smaller parts, tested directly (from the build, like everything else).

import { LIMITS, toProblem } from "@circuitlab/api-contract";
import { describe, expect, it } from "vitest";
import { accessOf, allows, denied, type AccessFacts, type CircuitAccess, type CircuitAction } from "../../dist/circuits/circuit-access";
import { AppConfig } from "../../dist/config/app-config";
import { PasswordsService } from "../../dist/auth/passwords.service";
import { formatRefreshToken, hashSecret, newSecret, parseRefreshToken } from "../../dist/auth/refresh-tokens";
import { SignInThrottle } from "../../dist/auth/sign-in-throttle";
import { isDatabaseUnavailable } from "../../dist/storage/database-errors";

describe("circuit access", () => {
  const facts = (overrides: Partial<AccessFacts> = {}): AccessFacts => ({ ownerId: "owner", visibility: "private", version: 1, sharedRole: undefined, ...overrides });

  it.each<[string, AccessFacts, string | undefined, CircuitAccess | undefined]>([
    ["the owner", facts(), "owner", "owner"],
    ["an editor", facts({ sharedRole: "editor" }), "bob", "editor"],
    ["a viewer", facts({ sharedRole: "viewer" }), "bob", "viewer"],
    ["a stranger, private", facts(), "bob", undefined],
    ["a stranger, public", facts({ visibility: "public" }), "bob", "public"],
    ["signed out, private", facts(), undefined, undefined],
    ["signed out, public", facts({ visibility: "public" }), undefined, "public"],
    ["an editor of a public circuit: the share is stronger", facts({ visibility: "public", sharedRole: "editor" }), "bob", "editor"],
  ])("%s", (_, given, userId, expected) => {
    expect(accessOf(given, userId)).toBe(expected);
  });

  it("allows exactly the table in circuit-access.ts", () => {
    const table = Object.fromEntries(
      (["owner", "editor", "viewer", "public"] as const).map((access) => [access, (["read", "edit", "manage"] as const).filter((action) => allows(access, action))]),
    );
    expect(table).toEqual({ owner: ["read", "edit", "manage"], editor: ["read", "edit"], viewer: ["read"], public: ["read"] });
  });

  it.each<[CircuitAccess, CircuitAction, RegExp]>([
    ["viewer", "edit", /shared with you as a viewer/],
    ["public", "edit", /This circuit is public/],
    ["editor", "manage", /Only the circuit's owner/],
  ])("explains a refusal: %s may not %s", (access, action, message) => {
    const problem = toProblem(denied(access, action));
    expect(problem.status).toBe(403);
    expect(problem.body.detail).toMatch(message);
  });
});

describe("sign-in throttle", () => {
  const window = LIMITS.signIn.windowSeconds * 1000;

  it(`blocks a key after ${LIMITS.signIn.maxFailures} failures, until the window since the first failure ends`, () => {
    const throttle = new SignInThrottle();
    const start = 1_000_000;
    for (let failure = 0; failure < LIMITS.signIn.maxFailures; failure++) {
      expect(() => throttle.check("ada", start + failure)).not.toThrow();
      throttle.failed("ada", start + failure);
    }
    const blocked = toProblem((() => {
      try {
        throttle.check("ada", start + 60_000);
      } catch (error) {
        return error;
      }
      return undefined;
    })());
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["Retry-After"])).toBe((window - 60_000) / 1000);
    expect(() => throttle.check("bob", start + 60_000)).not.toThrow(); // other keys are unaffected
    expect(() => throttle.check("ada", start + window)).not.toThrow(); // the window is over
  });

  it("forgets the failures after a successful sign-in", () => {
    const throttle = new SignInThrottle();
    for (let failure = 0; failure < LIMITS.signIn.maxFailures - 1; failure++) throttle.failed("ada", 0);
    throttle.succeeded("ada");
    throttle.failed("ada", 1);
    expect(() => throttle.check("ada", 2)).not.toThrow();
  });

  it("stays bounded in memory, and fast, however many keys an attacker invents", () => {
    const throttle = new SignInThrottle();
    const started = performance.now();
    for (let key = 0; key < 300_000; key++) throttle.failed(`key ${key}`, 0);
    // Pruning on every failure once full made this quadratic: minutes instead of well under a second.
    expect(performance.now() - started).toBeLessThan(3000);
    expect((throttle as unknown as { failures: Map<string, unknown> }).failures.size).toBeLessThanOrEqual(100_000);
  });
});

describe("refresh tokens", () => {
  it("are a session id and a 256-bit secret, read back exactly", () => {
    const secret = newSecret();
    const token = formatRefreshToken("01999999-9999-7999-8999-999999999999", secret);
    expect(parseRefreshToken(token)).toEqual({ sessionId: "01999999-9999-7999-8999-999999999999", secret });
    expect(hashSecret(secret)).toHaveLength(32);
    expect(hashSecret(secret)).not.toEqual(secret);
  });

  it.each(["", "a.b", "01999999-9999-7999-8999-999999999999.short", "01999999-9999-7999-8999-999999999999.x.y", `not-a-uuid.${"A".repeat(43)}`])(
    "refuses %j",
    (token) => {
      expect(parseRefreshToken(token)).toBeUndefined();
    },
  );
});

describe("passwords", () => {
  const passwords = new PasswordsService();

  it("hashes with Argon2id, verifies, and never matches a missing account", async () => {
    const hash = await passwords.hash("correct horse battery staple");
    // PHC string format: $argon2id$v=19$<parameters>$<salt>$<hash>, parameters in any order.
    expect(hash).toMatch(/^\$argon2id\$v=19\$[^$]+\$[^$]+\$[^$]+$/);
    expect(hash.split("$")[3]?.split(",").sort()).toEqual(["m=19456", "p=1", "t=2"]);
    expect(await passwords.verify(hash, "correct horse battery staple")).toBe(true);
    expect(await passwords.verify(hash, "correct horse battery stapler")).toBe(false);
    expect(await passwords.verify(undefined, "correct horse battery staple")).toBe(false);
    expect(passwords.needsRehash(hash)).toBe(false);
    expect(passwords.needsRehash("$argon2id$v=19$m=4096,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo")).toBe(true);
  });

  it("treats the same passphrase typed with different accent encodings as the same password", async () => {
    const hash = await passwords.hash("café au lait every morning");
    expect(await passwords.verify(hash, "café au lait every morning")).toBe(true);
  });
});

describe("configuration", () => {
  it("reads the environment, reporting every bad setting at once and never echoing a secret", () => {
    expect(() => AppConfig.fromEnvironment({ PORT: "x", DATABASE_URL: "mysql://u:hunter2@h/db", JWT_SECRET: "short-hunter2" })).toThrow(
      /PORT must be a whole number[\s\S]*DATABASE_URL must be a postgresql:\/\/ connection string[\s\S]*JWT_SECRET must be at least 32 characters/,
    );
    try {
      AppConfig.fromEnvironment({ DATABASE_URL: "mysql://u:hunter2@h/db", JWT_SECRET: "short-hunter2" });
    } catch (error) {
      expect((error as Error).message).not.toMatch(/hunter2/);
    }
    expect(AppConfig.fromEnvironment({ PORT: "8080", DATABASE_POOL_SIZE: "1" })).toMatchObject({ port: 8080, databasePoolSize: 1, databaseUrl: undefined });
  });
});

describe("database errors", () => {
  it.each<[string, unknown, boolean]>([
    ["can't reach the server (P1001)", { code: "P1001" }, true],
    ["timed out getting a connection (P2024)", { code: "P2024" }, true],
    ["a raw query to an unreachable server", { code: "P2010", meta: { driverAdapterError: { cause: { kind: "DatabaseNotReachable" } } } }, true],
    ["the server shutting down (57P01)", { code: "P2010", meta: { driverAdapterError: { cause: { kind: "postgres", code: "57P01" } } } }, true],
    ["a connection exception (08006)", { meta: { driverAdapterError: { cause: { kind: "postgres", code: "08006" } } } }, true],
    ["a unique violation (P2002)", { code: "P2002" }, false],
    ["a syntax error (42601)", { meta: { driverAdapterError: { cause: { kind: "postgres", code: "42601" } } } }, false],
    ["anything else", new Error("boom"), false],
    ["not even an object", "P1001", false],
  ])("%s: unavailable = %s", (_, error, unavailable) => {
    expect(isDatabaseUnavailable(error)).toBe(unavailable);
  });
});
