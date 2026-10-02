// The rules that depend on time, tested by moving an injected clock instead of waiting: what the
// Clock (dependency injection, phase 9) makes possible.

import { LIMITS } from "@circuitlab/api-contract";
import { describe, expect, it } from "vitest";
import { DAY, FakeClock, MINUTE } from "./support/clock";
import { Housekeeping } from "../dist/jobs/housekeeping.service";
import { JobsRepository } from "../dist/jobs/jobs.repository";
import { SETUPS, createCircuit, describeSetup, finishedJob, refresh, register, useServer } from "./support/server";

describe.each(SETUPS.map((setup) => ({ ...setup, name: describeSetup(setup) })))("time-dependent rules ($name)", (setup) => {
  const clock = new FakeClock();
  const context = useServer(setup, { clock });

  it(`expires an access token after ${LIMITS.accessTokenSeconds / 60} minutes; the refresh token gets a new one`, async () => {
    const { api } = context();
    const ada = await register(api, "Ada");
    clock.advance(14 * MINUTE);
    expect((await api.get("/v1/users/me", { as: ada })).status).toBe(200);
    clock.advance(2 * MINUTE);
    const expired = await api.get("/v1/users/me", { as: ada });
    expect([expired.status, expired.body.detail]).toEqual([401, "The access token has expired. Get a new one from /v1/auth/refresh."]);
    const refreshed = await api.post("/v1/auth/refresh", { json: { refreshToken: ada.refreshToken } });
    expect((await api.get("/v1/users/me", { headers: { Authorization: `Bearer ${refreshed.body.accessToken}` } })).status).toBe(200);
  });

  it(`ends a session after ${LIMITS.sessionDays} days without a refresh`, async () => {
    const { api } = context();
    const ada = await register(api, "Ada");
    clock.advance(LIMITS.sessionDays * DAY + MINUTE);
    expect((await api.post("/v1/auth/refresh", { json: { refreshToken: ada.refreshToken } })).status).toBe(401);
  });

  it("keeps a session alive as long as it is refreshed within each 30 days", async () => {
    const { api } = context();
    const ada = await register(api, "Ada");
    let refreshToken = ada.refreshToken;
    for (let month = 0; month < 3; month++) {
      clock.advance(29 * DAY);
      const reply = await api.post("/v1/auth/refresh", { json: { refreshToken } });
      expect(reply.status, `after ${(month + 1) * 29} days`).toBe(200);
      refreshToken = reply.body.refreshToken;
    }
  });

  it(`unblocks sign-ins ${LIMITS.signIn.windowSeconds / 60} minutes after the first failure`, async () => {
    const { api } = context();
    const ada = await register(api, "Ada");
    for (let attempt = 0; attempt < LIMITS.signIn.maxFailures; attempt++) {
      await api.post("/v1/auth/login", { json: { email: ada.email, password: `wrong guess ${attempt}` } });
    }
    expect((await api.post("/v1/auth/login", { json: { email: ada.email, password: ada.password } })).status).toBe(429);
    clock.advance(LIMITS.signIn.windowSeconds * 1000 - MINUTE);
    expect((await api.post("/v1/auth/login", { json: { email: ada.email, password: ada.password } })).status).toBe(429);
    clock.advance(MINUTE);
    expect((await api.post("/v1/auth/login", { json: { email: ada.email, password: ada.password } })).status).toBe(200);
  });

  it("stamps circuits, edits, and simulation runs with the same clock", async () => {
    const { api } = context();
    const ada = await register(api, "Ada");
    const created = await api.post("/v1/circuits", {
      as: ada,
      json: { name: "buffer", gates: [{ id: "A", type: "INPUT" }, { id: "Y", type: "OUTPUT" }], wires: [{ from: "A", to: "Y", toPin: 0 }] },
    });
    expect(created.body.createdAt).toBe(clock.now().toISOString());
    clock.advance(10 * MINUTE); // within the access token's 15 minutes
    const edited = await api.patch(`/v1/circuits/${created.body.id}`, { as: ada, json: { name: "renamed ten minutes later" } });
    expect([edited.body.createdAt, edited.body.updatedAt]).toEqual([created.body.createdAt, clock.now().toISOString()]);
    await api.post(`/v1/circuits/${created.body.id}/simulate`, { as: ada, json: { inputs: { A: 1 } } });
    const [run] = (await api.get(`/v1/circuits/${created.body.id}/runs`, { as: ada })).body.items;
    expect(run.createdAt).toBe(clock.now().toISOString());
  });

  it(`keeps a job's result for ${LIMITS.truthTableJobs.resultHours} hours, then answers 410`, async () => {
    const { api } = context();
    const ada = await register(api, "Ada");
    const id = await createCircuit(api, ada);
    const started = await api.post(`/v1/circuits/${id}/truth-table/jobs`, { as: ada, json: {} });
    const done = await finishedJob(api, ada, started.body.links.self);
    const hours = LIMITS.truthTableJobs.resultHours;
    expect(done.expiresAt).toBe(new Date(clock.now().getTime() + hours * 60 * MINUTE).toISOString());

    clock.advance(hours * 60 * MINUTE - MINUTE);
    await refresh(api, ada);
    expect((await api.get(started.body.links.self, { as: ada })).body.links.result).toBeDefined();
    expect((await api.get(`${started.body.links.self}/result`, { as: ada })).status).toBe(200);
    clock.advance(MINUTE);
    expect((await api.get(started.body.links.self, { as: ada })).body.links.result).toBeUndefined();
    const gone = await api.get(`${started.body.links.self}/result`, { as: ada });
    expect([gone.status, gone.body.code]).toEqual([410, "result-gone"]);
  });

  it(`allows ${LIMITS.truthTableJobs.perUserPerDay} jobs in any 24 hours, and says when the next one may start`, async () => {
    const { api } = context();
    const ada = await register(api, "Ada");
    const id = await createCircuit(api, ada);
    const start = () => api.post(`/v1/circuits/${id}/truth-table/jobs`, { as: ada, json: {} });
    const { perUserPerDay } = LIMITS.truthTableJobs;
    for (let n = 0; n < perUserPerDay; n++) {
      const job = await start();
      expect(job.status, `job ${n + 1}`).toBe(202);
      await finishedJob(api, ada, job.body.links.self);
      clock.advance(MINUTE / 2);
    }
    const refused = await start();
    expect([refused.status, refused.body.detail]).toEqual([429, `You have started ${perUserPerDay} jobs in the last 24 hours, the most allowed.`]);
    // The oldest started 24 hours before the allowance grows again.
    const wait = 24 * 60 * 60 - (perUserPerDay * MINUTE) / 2 / 1000;
    expect(refused.headers.get("retry-after")).toBe(String(wait));
    clock.advance(wait * 1000 - 1000);
    await refresh(api, ada);
    expect((await start()).status).toBe(429);
    clock.advance(1000);
    expect((await start()).status).toBe(202);
  });

  it("cleans up on schedule: a lost job is failed, and expired sessions are deleted", async () => {
    const { api, app } = context();
    const ada = await register(api, "Ada");
    const id = await createCircuit(api, ada);
    // A job no queue will ever run, as if Redis had lost it.
    const { job } = await app.get(JobsRepository, { strict: false }).create({ circuitId: id, circuitVersion: 1, userId: ada.id, offset: 0, limit: 4, createdAt: clock.now() }, () => {});
    const housekeeping = app.get(Housekeeping, { strict: false });
    await housekeeping.run();
    const url = `/v1/circuits/${id}/truth-table/jobs/${job.id}`;
    expect((await api.get(url, { as: ada })).body.status).toBe("queued"); // not lost yet: only waiting

    clock.advance(61 * MINUTE);
    await refresh(api, ada);
    expect((await housekeeping.run()).abandonedJobs).toBeGreaterThanOrEqual(1);
    expect((await api.get(url, { as: ada })).body).toMatchObject({ status: "failed", errorCode: "internal-error" });

    clock.advance(LIMITS.sessionDays * DAY);
    expect((await housekeeping.run()).expiredSessions).toBeGreaterThanOrEqual(1);
    expect((await api.post("/v1/auth/refresh", { json: { refreshToken: ada.refreshToken } })).status).toBe(401);
  });
});
