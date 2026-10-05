// What happens around Redis: starting without it, a separate Redis for the cache, and losing it
// while running. The Redis counterpart of database-failures.test.ts.

import type { AddressInfo } from "node:net";
import { AppConfig, createApp, type AppSettings } from "@circuitlab/api";
import { freePort } from "@circuitlab/database/local";
import type { INestApplication } from "@nestjs/common";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { Api } from "./support/client";
import { startRedis, type Container } from "./support/containers";
import { JWT_SECRET, createCircuit, finishedJob, register } from "./support/server";

const config = (settings: Partial<AppSettings>): AppConfig => new AppConfig({ simulationWorkers: 1, jwtSecret: JWT_SECRET, ...settings });

const running: { app: INestApplication; containers: Container[] }[] = [];
afterAll(async () => {
  for (const { app, containers } of running) {
    await app.close();
    for (const container of containers) await container.remove();
  }
});

/** The app on its own Redis containers, listening. */
async function serve(settings: Partial<AppSettings>, containers: Container[]): Promise<{ api: Api; app: INestApplication }> {
  const app = await createApp({ config: config(settings), logLevels: [] });
  running.push({ app, containers });
  await app.listen(0, "127.0.0.1");
  return { api: new Api(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`), app };
}

describe("starting without Redis", () => {
  it("refuses to start when Redis can't be reached, saying where, but never the password", async () => {
    const app = await createApp({ config: config({ redisUrl: `redis://:hunter2@127.0.0.1:${await freePort()}` }), logLevels: [] });
    const failure = await app.init().then(() => undefined, (error: unknown) => error as Error);
    await app.close().catch(() => undefined);
    expect(failure?.name).toBe("StartupError");
    expect(failure?.message).toMatch(/^Cannot reach Redis at 127\.0\.0\.1:\d+\. Is it running\? \(A local one starts with: npm run redis:start\)$/);
    expect(failure?.message).not.toContain("hunter2");
  });

  it("explains settings that can't work together", () => {
    expect(() => AppConfig.fromEnvironment({ JOB_CONCURRENCY: "0" })).toThrow(/JOB_CONCURRENCY=0 needs REDIS_URL/);
    expect(() => AppConfig.fromEnvironment({ REDIS_URL: "http://u:hunter2@cache", REDIS_PREFIX: "a b" })).toThrow(
      /REDIS_URL must be a redis:\/\/ connection string[\s\S]*REDIS_PREFIX may only hold/,
    );
    try {
      AppConfig.fromEnvironment({ REDIS_CACHE_URL: "http://u:hunter2@cache" });
    } catch (error) {
      expect((error as Error).message).not.toContain("hunter2");
    }
  });
});

describe("where things go in Redis", () => {
  it("keeps the cache in its own Redis when REDIS_CACHE_URL says so, and every key under REDIS_PREFIX", async () => {
    const [main, cache] = await Promise.all([startRedis(), startRedis()]);
    const { api } = await serve({ redisUrl: main.url, redisCacheUrl: cache.url, redisPrefix: "lab-tests" }, [main, cache]);
    const ada = await register(api, "Ada");
    const id = await createCircuit(api, ada);
    await api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A: 1, B: 1 } } });
    const job = await api.post(`/v1/circuits/${id}/truth-table/jobs`, { as: ada, json: {} });
    await finishedJob(api, ada, job.body.links.self);

    const keys = async (url: string): Promise<string[]> => {
      const client = new Redis(url);
      try {
        return (await client.keys("*")).sort();
      } finally {
        client.disconnect();
      }
    };
    const inCache = await keys(cache.url);
    const inMain = await keys(main.url);
    expect(inCache).toEqual([expect.stringMatching(/^lab-tests:cache:sim:/)]);
    expect(inMain.every((key) => key.startsWith("lab-tests:"))).toBe(true);
    expect(inMain).toContain(`lab-tests:results:${job.body.id}`);
    expect(inMain.some((key) => key.startsWith("lab-tests:bull:truth-tables:"))).toBe(true);
    expect(inMain).toContain("lab-tests:bull:housekeeping:repeat"); // the 10-minute schedule
    expect(inMain.some((key) => key.includes(":cache:"))).toBe(false);
  }, 60_000);
});

describe("losing Redis while running", () => {
  it("answers 503 where Redis is needed, keeps simulating without the cache, and recovers by itself", async () => {
    const redis = await startRedis();
    const { api } = await serve({ redisUrl: redis.url }, [redis]);
    const ada = await register(api, "Ada");
    const id = await createCircuit(api, ada);
    const simulate = (A: number) => api.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A, B: 1 } } });
    expect((await simulate(0)).headers.get("cache-status")).toBe("CircuitLab; fwd=miss; stored");
    const before = await api.post(`/v1/circuits/${id}/truth-table/jobs`, { as: ada, json: {} });
    await finishedJob(api, ada, before.body.links.self);

    await redis.stop();
    // A job's record is in the database: it can still be looked at, without the link to a result Redis holds.
    const record = await api.get(before.body.links.self, { as: ada });
    expect([record.status, record.body.status, record.body.links.result]).toEqual([200, "succeeded", undefined]);
    expect((await api.get(`${before.body.links.self}/result`, { as: ada })).status).toBe(503);
    // Simulating doesn't need Redis: the cache is skipped.
    const uncached = await simulate(1);
    expect([uncached.status, uncached.headers.get("cache-status"), uncached.body.outputs]).toEqual([200, "CircuitLab; fwd=miss", { S: 0, C: 1 }]);
    // Signing in (the throttle) and starting a job (the queue) do: 503, fast, with Retry-After.
    const signIn = await api.post("/v1/auth/login", { json: { email: ada.email, password: ada.password } });
    expect([signIn.status, signIn.body.code, signIn.headers.get("retry-after")]).toEqual([503, "server-unavailable", "5"]);
    const job = await api.post(`/v1/circuits/${id}/truth-table/jobs`, { as: ada, json: {} });
    expect([job.status, job.body.detail]).toEqual([503, "Redis is unavailable. Try again shortly."]);
    const health = await api.get("/health");
    expect([health.status, health.body.status, health.body.redis]).toEqual([503, "unavailable", { kind: "redis", reachable: false }]);
    // ...but the process itself is fine, and says so: a balancer that asked /health/live keeps sending it requests.
    const live = await api.get("/health/live");
    expect([live.status, live.body]).toEqual([200, { status: "ok" }]);
    // The job that couldn't be queued leaves no trace: it isn't waiting forever, nor using up Ada's allowance.
    const runs = await api.get(`/v1/circuits/${id}/runs`, { as: ada });
    expect(runs.body.items.filter((run: { kind: string }) => run.kind === "truth_table").map((run: { id: string }) => run.id)).toEqual([before.body.id]);

    await redis.start();
    await expect.poll(async () => (await api.get("/health")).status, { timeout: 15_000, interval: 200 }).toBe(200);
    expect((await api.post("/v1/auth/login", { json: { email: ada.email, password: ada.password } })).status).toBe(200);
    // BullMQ's connections come back too, within a couple of seconds.
    await expect.poll(async () => (await api.post(`/v1/circuits/${id}/truth-table/jobs`, { as: ada, json: {} })).status, { timeout: 15_000, interval: 500 }).toBe(202);
    const [queued] = (await api.get(`/v1/circuits/${id}/runs`, { as: ada })).body.items;
    expect((await finishedJob(api, ada, `/v1/circuits/${id}/truth-table/jobs/${queued.id}`)).status).toBe("succeeded");
  }, 90_000);

  it("doesn't hang when Redis stops answering: requests that need it fail after two seconds", async () => {
    const redis = await startRedis();
    const { api } = await serve({ redisUrl: redis.url }, [redis]);
    const ada = await register(api, "Ada");

    await redis.pause();
    try {
      const started = performance.now();
      const signIn = await api.post("/v1/auth/login", { json: { email: ada.email, password: ada.password } });
      const took = performance.now() - started;
      expect([signIn.status, signIn.body.code]).toEqual([503, "server-unavailable"]);
      expect(took).toBeGreaterThan(1500);
      expect(took).toBeLessThan(8000);
    } finally {
      await redis.unpause();
    }
    await expect.poll(async () => (await api.post("/v1/auth/login", { json: { email: ada.email, password: ada.password } })).status, { timeout: 15_000, interval: 200 }).toBe(200);
  }, 90_000);
});
