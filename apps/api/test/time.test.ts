// The rules that depend on time, tested by moving an injected clock instead of waiting: what the
// Clock (dependency injection, phase 9) makes possible.

import { LIMITS } from "@circuitlab/api-contract";
import { describe, expect, it } from "vitest";
import { DAY, FakeClock, MINUTE } from "./support/clock";
import { register, useServer, type Storage } from "./support/server";

describe.each<Storage>(["memory", "postgresql"])("time-dependent rules (%s)", (storage) => {
  const clock = new FakeClock();
  const context = useServer(storage, { clock });

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
});
