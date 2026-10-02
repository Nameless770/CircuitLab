// Real Redis (and, for the tests with several processes, a real PostgreSQL) in Docker containers,
// one set per test file, like the PGlite database each file gets. Nothing is shared between files,
// so they can run in parallel and never see each other's keys.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createPrismaClient } from "@circuitlab/database";
import { freePort } from "@circuitlab/database/local";
import { Redis } from "ioredis";

const run = promisify(execFile);

export const REDIS_IMAGE = "redis:8-alpine";
export const POSTGRES_IMAGE = "postgres:18-alpine";

export interface Container {
  readonly url: string;
  /** Stops the server, as a crash would; `start` brings it back on the same port. */
  stop(): Promise<void>;
  start(): Promise<void>;
  /** Freezes it: connections stay open, but nothing is answered, like an overloaded server. */
  pause(): Promise<void>;
  unpause(): Promise<void>;
  /** Removes it for good. */
  remove(): Promise<void>;
}

async function docker(...args: string[]): Promise<string> {
  try {
    return (await run("docker", args, { timeout: 120_000 })).stdout.trim();
  } catch (error) {
    const reason = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
    throw new Error(
      `These tests run Redis (and PostgreSQL) in Docker containers, so Docker must be running. "docker ${args.join(" ")}" failed: ${reason}`,
    );
  }
}

async function container(image: string, containerPort: number, env: Readonly<Record<string, string>>, url: (port: number) => string, ready: (url: string) => Promise<boolean>): Promise<Container> {
  const port = await freePort();
  const id = await docker("run", "-d", "-p", `127.0.0.1:${port}:${containerPort}`, ...Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]), image);
  const address = url(port);
  const waitUntilReady = async (): Promise<void> => {
    const deadline = Date.now() + 60_000;
    while (!(await ready(address))) {
      if (Date.now() > deadline) throw new Error(`${image} did not start within a minute`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  await waitUntilReady();
  return {
    url: address,
    stop: async () => void (await docker("stop", "-t", "1", id)),
    start: async () => {
      await docker("start", id);
      await waitUntilReady();
    },
    pause: async () => void (await docker("pause", id)),
    unpause: async () => void (await docker("unpause", id)),
    remove: async () => void (await docker("rm", "-f", "-v", id)),
  };
}

/** A fresh Redis 8, on a free port. */
export function startRedis(): Promise<Container> {
  return container(REDIS_IMAGE, 6379, {}, (port) => `redis://127.0.0.1:${port}`, async (url) => {
    const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    client.on("error", () => {});
    try {
      await client.connect();
      return (await client.ping()) === "PONG";
    } catch {
      return false;
    } finally {
      client.disconnect();
    }
  });
}

/** A fresh, empty PostgreSQL 18, on a free port. */
export function startPostgres(): Promise<Container> {
  return container(
    POSTGRES_IMAGE,
    5432,
    { POSTGRES_PASSWORD: "circuitlab-tests", POSTGRES_DB: "circuitlab" },
    (port) => `postgresql://postgres:circuitlab-tests@127.0.0.1:${port}/circuitlab`,
    async (url) => {
      // pg_isready inside the container would say "ready" during the image's first-start setup, after
      // which the server restarts once; a query over TCP from here only succeeds once it really serves.
      const client = createPrismaClient(url, { poolSize: 1 });
      try {
        await client.$queryRaw`SELECT 1`;
        return true;
      } catch {
        return false;
      } finally {
        await client.$disconnect();
      }
    },
  );
}
