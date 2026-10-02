import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { AppConfig, createApp, type AppSettings, type Clock } from "@circuitlab/api";
import { migrate, startLocalPostgres, type LocalPostgres } from "@circuitlab/database/local";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, expect } from "vitest";
import { Api, type Person } from "./client";
import { startRedis, type Container } from "./containers";

export type Storage = "memory" | "postgresql";

/** How a test file's server is set up. */
export interface Setup {
  readonly storage: Storage;
  /** The cache, the sign-in throttle, and jobs in a Redis of the file's own (in Docker), or in memory. */
  readonly redis: boolean;
}

/** Everything in memory, and the production arrangement: PostgreSQL and Redis. */
export const SETUPS: readonly Setup[] = [
  { storage: "memory", redis: false },
  { storage: "postgresql", redis: true },
];

export function describeSetup(setup: Setup): string {
  return setup.storage === "memory" ? "memory" : `PostgreSQL${setup.redis ? " and Redis" : ""}`;
}

/** Known to the tests, so they can sign tokens of their own (expired ones, forged ones). */
export const JWT_SECRET = "a secret only the tests and their server know";

export interface TestContext extends Setup {
  readonly api: Api;
  /** The running app, for the few tests that reach inside it (to run housekeeping, say). */
  readonly app: INestApplication;
  /** The file's Redis, when it has one. */
  readonly redisContainer: Container | undefined;
}

/**
 * Starts the real app for the test file: in memory, or on a fresh PostgreSQL (PGlite, migrated
 * with `prisma migrate deploy`, as in production) and, with `redis`, a fresh Redis. Returns a
 * getter, since the server only exists once beforeAll has run.
 */
export function useServer(setup: Setup, options: { readonly clock?: Clock; readonly settings?: Partial<AppSettings> } = {}): () => TestContext {
  let context: TestContext | undefined;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    let database: LocalPostgres | undefined;
    let redis: Container | undefined;
    try {
      if (setup.storage === "postgresql") {
        database = await startLocalPostgres();
        await migrate(database.url);
      }
      if (setup.redis) redis = await startRedis();
      const config = new AppConfig({
        simulationWorkers: 2,
        jwtSecret: JWT_SECRET,
        // One connection: the local PostgreSQL can't interleave several (see local-postgres.ts).
        ...(database !== undefined && { databaseUrl: database.url, databasePoolSize: 1 }),
        ...(redis !== undefined && { redisUrl: redis.url }),
        ...options.settings,
      });
      const app = await createApp({ config, logLevels: ["error"], ...(options.clock !== undefined && { clock: options.clock }) });
      await app.listen(0, "127.0.0.1");
      const { port } = app.getHttpServer().address() as AddressInfo;
      context = { api: new Api(`http://127.0.0.1:${port}`), ...setup, app, redisContainer: redis };
      close = async () => {
        await app.close();
        await database?.stop();
        await redis?.remove();
      };
    } catch (error) {
      await database?.stop();
      await redis?.remove();
      throw error;
    }
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  return () => {
    if (context === undefined) throw new Error("The server isn't running yet: use the context inside a test or hook");
    return context;
  };
}

/** Registers a new account with a unique address, signed in. */
export async function register(api: Api, name: string): Promise<Person> {
  const email = `${name.toLowerCase()}.${randomUUID().slice(0, 8)}@example.com`;
  const password = `${name}'s passphrase for the tests`;
  const reply = await api.post("/v1/auth/register", { json: { email, password, displayName: name } });
  expect(reply.status, reply.text).toBe(201);
  return { name, email, password, id: reply.body.user.id, token: reply.body.accessToken, refreshToken: reply.body.refreshToken };
}

/** The half adder, as a JSON body for creating or replacing a circuit. */
export function halfAdderBody(name = "Half adder") {
  return {
    name,
    gates: [
      { id: "A", type: "INPUT" },
      { id: "B", type: "INPUT" },
      { id: "sum", type: "XOR" },
      { id: "carry", type: "AND" },
      { id: "S", type: "OUTPUT" },
      { id: "C", type: "OUTPUT" },
    ],
    wires: [
      { from: "A", to: "sum", toPin: 0 },
      { from: "B", to: "sum", toPin: 1 },
      { from: "A", to: "carry", toPin: 0 },
      { from: "B", to: "carry", toPin: 1 },
      { from: "sum", to: "S", toPin: 0 },
      { from: "carry", to: "C", toPin: 0 },
    ],
  };
}

/** Creates a circuit as `owner` and returns its id. */
export async function createCircuit(api: Api, owner: Person, body: unknown = halfAdderBody()): Promise<string> {
  const reply = await api.post("/v1/circuits", { as: owner, json: body });
  expect(reply.status, reply.text).toBe(201);
  return reply.body.id;
}

/**
 * An n-bit ripple-carry adder as a JSON body: inputs a0..a(n-1) and b0..b(n-1), outputs S0..S(n-1)
 * and COUT. Its truth table has 4^n rows, which makes it handy for tables of any size.
 */
export function adderBody(bits: number, name = `${bits}-bit adder`) {
  const gates: { id: string; type: string }[] = [];
  const wires: { from: string; to: string; toPin: number }[] = [];
  const wire = (from: string, to: string, toPin: number): void => void wires.push({ from, to, toPin });
  for (let i = 0; i < bits; i++) gates.push({ id: `a${i}`, type: "INPUT" }, { id: `b${i}`, type: "INPUT" });
  let carry: string | undefined;
  for (let i = 0; i < bits; i++) {
    gates.push({ id: `x${i}`, type: "XOR" }, { id: `s${i}`, type: carry === undefined ? "BUF" : "XOR" }, { id: `g${i}`, type: "AND" });
    wire(`a${i}`, `x${i}`, 0);
    wire(`b${i}`, `x${i}`, 1);
    wire(`a${i}`, `g${i}`, 0);
    wire(`b${i}`, `g${i}`, 1);
    wire(`x${i}`, `s${i}`, 0);
    if (carry === undefined) {
      carry = `g${i}`;
    } else {
      gates.push({ id: `p${i}`, type: "AND" }, { id: `c${i}`, type: "OR" });
      wire(carry, `s${i}`, 1);
      wire(`x${i}`, `p${i}`, 0);
      wire(carry, `p${i}`, 1);
      wire(`g${i}`, `c${i}`, 0);
      wire(`p${i}`, `c${i}`, 1);
      carry = `c${i}`;
    }
    gates.push({ id: `S${i}`, type: "OUTPUT" });
    wire(`s${i}`, `S${i}`, 0);
  }
  gates.push({ id: "COUT", type: "OUTPUT" });
  wire(carry ?? "a0", "COUT", 0);
  return { name, gates, wires };
}

/** Polls a job (as `who`) until it has finished, and returns it. */
export async function finishedJob(api: Api, who: Person, url: string, timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const reply = await api.get(url, { as: who });
    expect(reply.status, reply.text).toBe(200);
    if (!["queued", "running"].includes(reply.body.status)) return reply.body;
    if (Date.now() > deadline) throw new Error(`The job at ${url} was still ${reply.body.status} after ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Trades `who`'s refresh token for new tokens, as a client does once its access token has expired. */
export async function refresh(api: Api, who: Person): Promise<void> {
  const reply = await api.post("/v1/auth/refresh", { json: { refreshToken: who.refreshToken } });
  expect(reply.status, reply.text).toBe(200);
  who.token = reply.body.accessToken;
  who.refreshToken = reply.body.refreshToken;
}
