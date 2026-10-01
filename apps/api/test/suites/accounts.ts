import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JWT_SECRET, register, type TestContext } from "../support/server";

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const sign = (header: string, payload: string, key: string): string => createHmac("sha256", key).update(`${header}.${payload}`).digest("base64url");

/** Replaces an access token's payload, keeping the header; signs with `key`, or keeps the old signature. */
function forge(token: string, change: (claims: Record<string, any>) => Record<string, any>, key?: string): string {
  const [header = "", payload = "", signature = ""] = token.split(".");
  const changed = encode(change(JSON.parse(Buffer.from(payload, "base64url").toString())));
  return `${header}.${changed}.${key === undefined ? signature : sign(header, changed, key)}`;
}

export function accountsSuite(context: () => TestContext): void {
  describe("accounts", () => {
    it("registers, signs in at once, and identifies the user from the access token", async () => {
      const { api } = context();
      const padded = await api.post("/v1/auth/register", { json: { email: " grace.h@example.com ", password: "a long passphrase to remember", displayName: "Grace" } });
      expect([padded.status, padded.body.issues?.[0]?.pointer]).toEqual([422, "/email"]); // an address is checked as sent
      const reply = await api.post("/v1/auth/register", { json: { email: "Grace.H@Example.com", password: "a long passphrase to remember", displayName: "Grace" } });
      expect(reply.status).toBe(201);
      expect(reply.headers.get("cache-control")).toBe("no-store");
      expect(reply.body).toMatchObject({ tokenType: "Bearer", expiresIn: 900, user: { email: "grace.h@example.com", displayName: "Grace" } });
      const me = await api.get("/v1/users/me", { headers: { Authorization: `Bearer ${reply.body.accessToken}` } });
      expect(me.body).toMatchObject({ id: reply.body.user.id, email: "grace.h@example.com" });
    });

    it("allows one account per address, however it is capitalized", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const reply = await api.post("/v1/auth/register", { json: { email: ada.email.toUpperCase(), password: "another long passphrase", displayName: "Ada again" } });
      expect(reply.status).toBe(409);
      expect(reply.body.code).toBe("email-taken");
    });

    it("refuses a short password, saying where", async () => {
      const reply = await context().api.post("/v1/auth/register", { json: { email: "eve@example.com", password: "P@ssw0rd!", displayName: "Eve" } });
      expect(reply.status).toBe(422);
      expect(reply.body.issues).toEqual([expect.objectContaining({ code: "TOO_SHORT", pointer: "/password" })]);
    });

    it("signs in with the password, whatever the address's capitals", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const reply = await api.post("/v1/auth/login", { json: { email: ada.email.toUpperCase(), password: ada.password } });
      expect(reply.status).toBe(200);
      expect(reply.body.user.id).toBe(ada.id);
    });

    it("gives the same answer for a wrong password and for an address with no account", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const wrong = await api.post("/v1/auth/login", { json: { email: ada.email, password: "not the password at all" } });
      const nobody = await api.post("/v1/auth/login", { json: { email: "nobody.at.all@example.com", password: "not the password at all" } });
      expect(wrong.status).toBe(401);
      expect(nobody.status).toBe(401);
      expect(nobody.body).toEqual(wrong.body);
      expect(wrong.headers.get("www-authenticate")).toBe('Bearer realm="circuitlab"');
    });

    it("blocks an account from an address after 5 failed sign-ins, even with the right password", async () => {
      const { api } = context();
      const target = await register(api, "Target");
      const bystander = await register(api, "Bystander");
      for (let attempt = 1; attempt <= 5; attempt++) {
        expect((await api.post("/v1/auth/login", { json: { email: target.email, password: `guess ${attempt}` } })).status).toBe(401);
      }
      const blocked = await api.post("/v1/auth/login", { json: { email: target.email, password: target.password } });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(800);
      // Other accounts from the same address are unaffected.
      expect((await api.post("/v1/auth/login", { json: { email: bystander.email, password: bystander.password } })).status).toBe(200);
    });

    it("needs a token for /users/me, and says how to send one", async () => {
      const reply = await context().api.get("/v1/users/me");
      expect(reply.status).toBe(401);
      expect(reply.body.code).toBe("unauthenticated");
      expect(reply.headers.get("www-authenticate")).toBe('Bearer realm="circuitlab"');
    });
  });

  describe("access tokens", () => {
    it.each<[string, (token: string) => string]>([
      ["a changed payload with the old signature", (token) => forge(token, (claims) => ({ ...claims, sub: "someone-else" }))],
      ["an unsigned token (alg: none)", (token) => `${encode({ alg: "none", typ: "JWT" })}.${token.split(".")[1]}.`],
      ["a token signed with another key", (token) => forge(token, (claims) => claims, "not the server's key at all, no")],
      ["a correctly signed token that expired", (token) => forge(token, (claims) => ({ ...claims, iat: claims.iat - 3600, exp: claims.iat - 1800 }), JWT_SECRET)],
      ["a token for another audience", (token) => forge(token, (claims) => ({ ...claims, aud: "another-api" }), JWT_SECRET)],
      ["a token without a subject", (token) => forge(token, ({ sub: _, ...claims }) => claims, JWT_SECRET)],
      ["something that isn't a JWT", () => "not-a-jwt"],
    ])("refuses %s with 401 invalid-token", async (_, tamper) => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const reply = await api.get("/v1/users/me", { headers: { Authorization: `Bearer ${tamper(ada.token)}` } });
      expect(reply.status).toBe(401);
      expect(reply.body.code).toBe("invalid-token");
      expect(reply.headers.get("www-authenticate")).toBe('Bearer realm="circuitlab", error="invalid_token"');
    });

    it("refuses other schemes than Bearer", async () => {
      const reply = await context().api.get("/v1/users/me", { headers: { Authorization: "Basic YWRhOnNlY3JldA==" } });
      expect(reply.body.code).toBe("invalid-token");
    });

    it("refuses a bad token even where none is needed, instead of quietly treating the caller as signed out", async () => {
      const reply = await context().api.get("/v1/circuits?scope=public", { headers: { Authorization: "Bearer not-a-jwt" } });
      expect(reply.status).toBe(401);
    });
  });

  describe("refresh tokens and signing out", () => {
    it("trades a refresh token for a new pair; each refresh token works once", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const first = await api.post("/v1/auth/refresh", { json: { refreshToken: ada.refreshToken } });
      expect(first.status).toBe(200);
      expect(first.body.refreshToken).not.toBe(ada.refreshToken);
      expect((await api.get("/v1/users/me", { headers: { Authorization: `Bearer ${first.body.accessToken}` } })).status).toBe(200);
      const second = await api.post("/v1/auth/refresh", { json: { refreshToken: first.body.refreshToken } });
      expect(second.status).toBe(200);
    });

    it("ends the whole session when a used refresh token comes back (someone has a copy)", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const fresh = await api.post("/v1/auth/refresh", { json: { refreshToken: ada.refreshToken } });
      const replay = await api.post("/v1/auth/refresh", { json: { refreshToken: ada.refreshToken } });
      expect(replay.status).toBe(401);
      expect(replay.body.code).toBe("invalid-token");
      // The legitimate new token died with the session: owner and thief both sign in again.
      expect((await api.post("/v1/auth/refresh", { json: { refreshToken: fresh.body.refreshToken } })).status).toBe(401);
    });

    it("keeps other sessions of the same user alive", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const laptop = await api.post("/v1/auth/login", { json: { email: ada.email, password: ada.password } });
      await api.post("/v1/auth/refresh", { json: { refreshToken: ada.refreshToken } });
      await api.post("/v1/auth/refresh", { json: { refreshToken: ada.refreshToken } }); // the phone's session ends
      expect((await api.post("/v1/auth/refresh", { json: { refreshToken: laptop.body.refreshToken } })).status).toBe(200);
    });

    it("signs out: the refresh token stops working; the access token lives out its 15 minutes", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      expect((await api.post("/v1/auth/logout", { json: { refreshToken: ada.refreshToken } })).status).toBe(204);
      expect((await api.post("/v1/auth/refresh", { json: { refreshToken: ada.refreshToken } })).status).toBe(401);
      expect((await api.get("/v1/users/me", { as: ada })).status).toBe(200);
    });

    it("answers 204 to signing out with a token that is already invalid", async () => {
      expect((await context().api.post("/v1/auth/logout", { json: { refreshToken: "nonsense" } })).status).toBe(204);
    });

    it("lets a client with an expired access token still refresh (the account endpoints ignore it)", async () => {
      const { api } = context();
      const ada = await register(api, "Ada");
      const expired = forge(ada.token, (claims) => ({ ...claims, exp: claims.iat - 1 }), JWT_SECRET);
      const reply = await api.post("/v1/auth/refresh", { json: { refreshToken: ada.refreshToken }, headers: { Authorization: `Bearer ${expired}` } });
      expect(reply.status).toBe(200);
    });

    it.each(["not a token", "00000000-0000-7000-8000-000000000000.AAAA", `${"0".repeat(8)}-0000-7000-8000-000000000000.${"A".repeat(43)}`])(
      "refuses %j as a refresh token",
      async (refreshToken) => {
        expect((await context().api.post("/v1/auth/refresh", { json: { refreshToken } })).status).toBe(401);
      },
    );
  });
}
