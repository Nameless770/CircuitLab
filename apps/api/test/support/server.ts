import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { AppConfig, createApp } from "@circuitlab/api";
import { migrate, startLocalPostgres, type LocalPostgres } from "@circuitlab/database/local";
import { afterAll, beforeAll, expect } from "vitest";
import { Api, type Person } from "./client";

export type Storage = "memory" | "postgresql";

/** Known to the tests, so they can sign tokens of their own (expired ones, forged ones). */
export const JWT_SECRET = "a secret only the tests and their server know";

export interface TestContext {
  readonly api: Api;
  readonly storage: Storage;
}

/**
 * Starts the real app for the test file: in memory, or on a fresh PostgreSQL (PGlite, migrated
 * with `prisma migrate deploy`, as in production). Returns a getter, since the server only exists
 * once beforeAll has run.
 */
export function useServer(storage: Storage): () => TestContext {
  let context: TestContext | undefined;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    let database: LocalPostgres | undefined;
    if (storage === "postgresql") {
      database = await startLocalPostgres();
      await migrate(database.url);
    }
    const config = new AppConfig({
      simulationWorkers: 2,
      jwtSecret: JWT_SECRET,
      // One connection: the local PostgreSQL can't interleave several (see local-postgres.ts).
      ...(database !== undefined && { databaseUrl: database.url, databasePoolSize: 1 }),
    });
    const app = await createApp({ config, logLevels: ["error"] });
    await app.listen(0, "127.0.0.1");
    const { port } = app.getHttpServer().address() as AddressInfo;
    context = { api: new Api(`http://127.0.0.1:${port}`), storage };
    close = async () => {
      await app.close();
      await database?.stop();
    };
  }, 60_000);

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
