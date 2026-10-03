// The two settings that matter once the API is on the internet behind a reverse proxy
// (docs/deploy.md): TRUST_PROXY, which says whose word to take for a client's address, and
// AUTH_RATE_LIMIT, which caps the password hashes one address can ask for (docs/system-design.md
// measured why: a container's CPUs go to hashing, and nothing else gets them).
//
// A proxy tells the API the client's address in X-Forwarded-For; the tests play the proxy by
// sending that header themselves.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Api } from "./support/client";
import { FakeClock, MINUTE } from "./support/clock";
import { SETUPS, describeSetup, refresh, register, useServer } from "./support/server";

const from = (address: string) => ({ "X-Forwarded-For": address });

interface Credentials {
  readonly email: string;
  readonly password: string;
}

/** Registers an account as if from `address`. */
async function signUp(api: Api, name: string, address: string): Promise<Credentials & { readonly status: number }> {
  const email = `${name.toLowerCase()}.${randomUUID().slice(0, 8)}@example.com`;
  const password = `${name}'s passphrase for the tests`;
  const reply = await api.post("/v1/auth/register", { json: { email, password, displayName: name }, headers: from(address) });
  return { email, password, status: reply.status };
}

const signIn = (api: Api, who: Credentials, address: string, password = who.password) =>
  api.post("/v1/auth/login", { json: { email: who.email, password }, headers: from(address) });

const LIMIT = 5;

describe.each(SETUPS.map((setup) => ({ ...setup, name: describeSetup(setup) })))("the limit on sign-ins and registrations per address ($name)", (setup) => {
  const clock = new FakeClock();
  const context = useServer(setup, { clock, settings: { trustProxy: 1, authRateLimit: LIMIT } });

  it(`answers 429, with Retry-After, once an address has signed in ${LIMIT} times in a minute, whether the attempts worked or not`, async () => {
    const { api } = context();
    const ada = await signUp(api, "Ada", "192.0.2.1");
    const statuses: number[] = [];
    for (const password of [ada.password, ada.password, "a wrong guess", ada.password, "another wrong guess"]) {
      statuses.push((await signIn(api, ada, "203.0.113.7", password)).status);
    }
    expect(statuses).toEqual([200, 200, 401, 200, 401]);

    const blocked = await signIn(api, ada, "203.0.113.7");
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: "too-many-requests" });
    expect(blocked.body.detail).toMatch(/sign-in and registration attempts from this address/);
    const retryAfter = Number(blocked.headers.get("retry-after"));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("counts registrations too: they cost the same hash", async () => {
    const { api } = context();
    const statuses: number[] = [];
    for (let i = 0; i < LIMIT + 1; i++) statuses.push((await signUp(api, `Person${i}`, "203.0.113.20")).status);
    expect(statuses).toEqual([...Array(LIMIT).fill(201), 429]);
  });

  it("keeps a count for each address, so one address being blocked doesn't touch another", async () => {
    const { api } = context();
    const ada = await signUp(api, "Ada", "192.0.2.2");
    for (let i = 0; i < LIMIT; i++) await signIn(api, ada, "203.0.113.30");
    expect((await signIn(api, ada, "203.0.113.30")).status).toBe(429);
    expect((await signIn(api, ada, "203.0.113.31")).status).toBe(200);
    // The socket's own address (no X-Forwarded-For) is an address like any other.
    expect((await api.post("/v1/auth/login", { json: { email: ada.email, password: ada.password } })).status).toBe(200);
  });

  it("starts a new count with each minute", async () => {
    const { api } = context();
    const ada = await signUp(api, "Ada", "192.0.2.3");
    for (let i = 0; i < LIMIT; i++) expect((await signIn(api, ada, "203.0.113.40")).status).toBe(200);
    expect((await signIn(api, ada, "203.0.113.40")).status).toBe(429);
    clock.advance(MINUTE + 1000);
    expect((await signIn(api, ada, "203.0.113.40")).status).toBe(200);
  });

  it("doesn't limit what costs no hash: refreshing a token, or asking for anything else", async () => {
    const { api } = context();
    const ada = await register(api, "Ada"); // from the socket's own address, which the other tests don't use up
    const address = "203.0.113.50";
    for (let i = 0; i < LIMIT + 1; i++) await signIn(api, ada, address);
    expect((await signIn(api, ada, address)).status).toBe(429);
    for (let i = 0; i < LIMIT + 2; i++) await refresh(api, ada);
    expect((await api.get("/v1/users/me", { as: ada, headers: from(address) })).status).toBe(200);
  });
});

describe("behind one proxy", () => {
  const context = useServer({ storage: "memory", redis: false }, { settings: { trustProxy: 1 } });

  it("counts failed sign-ins by the client's address, as the proxy reports it, not by the proxy's", async () => {
    const { api } = context();
    const ada = await register(api, "Ada");
    for (let i = 0; i < 5; i++) expect((await signIn(api, ada, "198.51.100.1", `wrong guess ${i}`)).status).toBe(401);
    const blocked = await signIn(api, ada, "198.51.100.1");
    expect([blocked.status, blocked.body.detail]).toEqual([429, expect.stringMatching(/Too many failed sign-ins/)]);
    // Another client of the same proxy is not locked out of the account by it.
    expect((await signIn(api, ada, "198.51.100.2")).status).toBe(200);
  });

  it("believes only the proxy's own hop: a client's made-up addresses further left don't count", async () => {
    const { api } = context();
    const ada = await register(api, "Ada");
    // The proxy appends the address it saw; a client that sends its own header gets it in front of
    // that one. With one proxy trusted, only the last entry is believed.
    for (let i = 0; i < 5; i++) await signIn(api, ada, `10.0.0.${i}, 198.51.100.9`, `wrong guess ${i}`);
    expect((await signIn(api, ada, "10.0.0.99, 198.51.100.9")).status).toBe(429);
  });
});

describe("with no proxy trusted (the default)", () => {
  const context = useServer({ storage: "memory", redis: false }, { settings: { authRateLimit: LIMIT } });

  it("ignores X-Forwarded-For, since any client could write whatever it likes there", async () => {
    const { api } = context();
    const ada = await register(api, "Ada"); // one attempt, by the socket's address
    // Four more, each claiming to be someone else: they all count against the real address.
    for (let i = 0; i < LIMIT - 1; i++) expect((await signIn(api, ada, `203.0.113.${100 + i}`)).status).toBe(200);
    expect((await signIn(api, ada, "203.0.113.200")).status).toBe(429);
  });
});
