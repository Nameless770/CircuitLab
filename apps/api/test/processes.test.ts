// Several processes sharing one PostgreSQL and one Redis, as in production: two API instances that
// only take requests (JOB_CONCURRENCY=0), and a separate worker that computes the jobs. Each runs
// in its own Nest application here, which is what a process holds; the database is a real
// PostgreSQL server in Docker, since several processes can't share one PGlite.

import type { AddressInfo } from "node:net";
import { AppConfig, createApp, createWorker, type AppSettings } from "@circuitlab/api";
import { migrate } from "@circuitlab/database/local";
import type { INestApplicationContext } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Api, type Person } from "./support/client";
import { startPostgres, startRedis, type Container } from "./support/containers";
import { JWT_SECRET, adderBody, createCircuit, finishedJob, halfAdderBody, register } from "./support/server";

let postgres: Container;
let redis: Container;
const apps: INestApplicationContext[] = [];
const workers: INestApplicationContext[] = [];
let first: Api;
let second: Api;

const settings = (): Partial<AppSettings> => ({ simulationWorkers: 2, jwtSecret: JWT_SECRET, databaseUrl: postgres.url, redisUrl: redis.url });

async function apiInstance(): Promise<Api> {
  const app = await createApp({ config: new AppConfig({ ...settings(), jobConcurrency: 0 }), logLevels: ["error"] });
  apps.push(app);
  await app.listen(0, "127.0.0.1");
  return new Api(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
}

async function workerProcess(extra: Partial<AppSettings> = {}): Promise<INestApplicationContext> {
  const worker = await createWorker({ config: new AppConfig({ ...settings(), ...extra }), logLevels: ["error"] });
  workers.push(worker);
  return worker;
}

async function stop(worker: INestApplicationContext): Promise<void> {
  workers.splice(workers.indexOf(worker), 1);
  await worker.close();
}

beforeAll(async () => {
  [postgres, redis] = await Promise.all([startPostgres(), startRedis()]);
  await migrate(postgres.url);
  [first, second] = await Promise.all([apiInstance(), apiInstance()]);
}, 180_000);

afterAll(async () => {
  for (const app of [...workers, ...apps]) await app.close();
  await Promise.all([postgres?.remove(), redis?.remove()]);
});

const jobsOf = (id: string): string => `/v1/circuits/${id}/truth-table/jobs`;

describe("API instances and a separate worker", () => {
  it("queue jobs in one instance, follow them in another, and leave the computing to the worker", async () => {
    const ada = await register(first, "Ada");
    const table = await createCircuit(first, ada, adderBody(4));
    const other = await createCircuit(first, ada);

    // No instance computes jobs, so they wait.
    const job = await first.post(jobsOf(table), { as: ada, json: {} });
    expect(job.body.status).toBe("queued");
    // The same request again, through the other instance (a client retrying after a lost answer): the same job.
    const retried = await second.post(jobsOf(table), { as: ada, json: {} });
    expect([retried.status, retried.body.id, retried.headers.get("location")]).toEqual([202, job.body.id, job.body.links.self]);

    const doomed = await second.post(jobsOf(other), { as: ada, json: {} });
    const third = await first.post(jobsOf(table), { as: ada, json: { limit: 10 } });
    expect([third.status, third.body.code, third.headers.get("retry-after")]).toEqual([429, "too-many-requests", "2"]);
    expect(third.body.detail).toBe("You already have 2 jobs waiting or running. Wait for one to finish, or delete one.");

    const early = await second.get(`${job.body.links.self}/result`, { as: ada });
    expect([early.status, early.body.code, early.headers.get("retry-after")]).toEqual([409, "job-unfinished", "2"]);

    // Cancelling frees a place; a job for a circuit that then changes can never run as asked.
    expect((await second.delete(doomed.body.links.self, { as: ada })).status).toBe(204);
    const pinned = await first.post(jobsOf(other), { as: ada, json: { offset: 1 } });
    expect(pinned.status).toBe(202);
    await first.put(`/v1/circuits/${other}`, { as: ada, json: halfAdderBody("Changed") });

    await workerProcess();
    expect(await finishedJob(second, ada, job.body.links.self)).toMatchObject({ status: "succeeded", rowsDone: 256 });
    expect(await finishedJob(first, ada, doomed.body.links.self)).toMatchObject({ status: "cancelled" });
    const failed = await finishedJob(second, ada, pinned.body.links.self);
    expect(failed).toMatchObject({ status: "failed", errorCode: "version-conflict" });
    const noResult = await first.get(`${pinned.body.links.self}/result`, { as: ada });
    expect([noResult.status, noResult.body.detail]).toEqual([409, "The job failed (version-conflict), so it has no result. Start a new job."]);

    const download = await second.get(`${job.body.links.self}/result`, { as: ada });
    const direct = await first.get(`/v1/circuits/${table}/truth-table`, { as: ada, headers: { Accept: "text/csv" } });
    expect(download.text).toBe(direct.text);
  }, 60_000);

  it("report a running job's progress to every instance", async () => {
    const ada = await register(first, "Ada");
    const id = await createCircuit(first, ada, adderBody(10)); // 1,048,576 rows
    const job = await first.post(jobsOf(id), { as: ada, json: {} });
    const seen: { status: string; rowsDone: number }[] = [];
    for (;;) {
      const reply = await second.get(job.body.links.self, { as: ada });
      seen.push({ status: reply.body.status, rowsDone: reply.body.rowsDone });
      if (!["queued", "running"].includes(reply.body.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(seen.at(-1)).toEqual({ status: "succeeded", rowsDone: 1_048_576 });
    const partway = seen.filter(({ status, rowsDone }) => status === "running" && rowsDone > 0 && rowsDone < 1_048_576);
    expect(partway.length).toBeGreaterThan(0);
    expect(seen.map(({ rowsDone }) => rowsDone)).toEqual(seen.map(({ rowsDone }) => rowsDone).sort((a, b) => a - b)); // never goes back
  }, 60_000);

  it("finish a job on another worker when its worker stops halfway", async () => {
    const ada = await register(first, "Ada");
    const id = await createCircuit(first, ada, adderBody(10));
    // Replace the worker from the first test with one that is quick to stop.
    for (const worker of [...workers]) await stop(worker);
    const impatient = await workerProcess({ shutdownGraceMs: 50 });
    const job = await first.post(jobsOf(id), { as: ada, json: {} });
    await expect.poll(async () => (await second.get(job.body.links.self, { as: ada })).body.rowsDone, { timeout: 20_000, interval: 20 }).toBeGreaterThan(0);

    await stop(impatient); // its attempt fails ("shutting down") and goes back to the queue
    const stalled = await second.get(job.body.links.self, { as: ada });
    expect(stalled.body.status).toBe("running"); // not failed: another worker will take it

    await workerProcess();
    expect(await finishedJob(second, ada, job.body.links.self)).toMatchObject({ status: "succeeded", rowsDone: 1_048_576 });
  }, 60_000);
});

describe("API instances sharing Redis", () => {
  it("count failed sign-ins together, so spreading guesses over instances doesn't help", async () => {
    const ada = await register(first, "Ada");
    for (let attempt = 0; attempt < 5; attempt++) {
      const api = attempt % 2 === 0 ? first : second;
      expect((await api.post("/v1/auth/login", { json: { email: ada.email, password: `wrong guess ${attempt}` } })).status).toBe(401);
    }
    const blocked = await second.post("/v1/auth/login", { json: { email: ada.email, password: ada.password } });
    expect([blocked.status, blocked.body.code]).toEqual([429, "too-many-requests"]);
  });

  it("share one cache: what one instance computed, the other finds", async () => {
    const ada: Person = await register(first, "Ada");
    const id = await createCircuit(first, ada);
    const fromFirst = await first.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A: 1, B: 0 } } });
    const fromSecond = await second.post(`/v1/circuits/${id}/simulate`, { as: ada, json: { inputs: { A: 1, B: 0 } } });
    expect([fromFirst.headers.get("cache-status"), fromSecond.headers.get("cache-status")]).toEqual(["CircuitLab; fwd=miss; stored", "CircuitLab; hit"]);
    expect(fromSecond.body).toEqual(fromFirst.body);
  });
});
