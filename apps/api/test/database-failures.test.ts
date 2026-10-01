// What happens when the database isn't there, or isn't ready: phase 6's promises, kept.

import type { AddressInfo } from "node:net";
import { AppConfig, createApp } from "@circuitlab/api";
import { freePort, migrate, startLocalPostgres } from "@circuitlab/database/local";
import { describe, expect, it } from "vitest";
import { Api } from "./support/client";
import { JWT_SECRET } from "./support/server";

const config = (databaseUrl: string): AppConfig => new AppConfig({ simulationWorkers: 1, jwtSecret: JWT_SECRET, databaseUrl, databasePoolSize: 1 });

describe("starting without a usable database", () => {
  it("refuses to start when the database can't be reached, saying where, but never the password", async () => {
    const url = `postgresql://postgres:hunter2@127.0.0.1:${await freePort()}/postgres`;
    const app = await createApp({ config: config(url), logLevels: [] });
    const failure = await app.init().then(() => undefined, (error: unknown) => error as Error);
    await app.close().catch(() => undefined);
    expect(failure?.name).toBe("StartupError");
    expect(failure?.message).toMatch(/^Cannot reach the database at 127\.0\.0\.1:\d+\/postgres\. Is it running\?/);
    expect(failure?.message).not.toContain("hunter2");
  });

  it("refuses to start on a database without the migrations, and says how to apply them", async () => {
    const database = await startLocalPostgres();
    try {
      const app = await createApp({ config: config(database.url), logLevels: [] });
      const failure = await app.init().then(() => undefined, (error: unknown) => error as Error);
      await app.close().catch(() => undefined);
      expect(failure?.message).toMatch(/has no CircuitLab tables yet\. Apply the migrations: npm run db:migrate$/);
    } finally {
      await database.stop();
    }
  }, 60_000);
});

describe("losing the database while running", () => {
  it("answers 503 with Retry-After while it is gone, and recovers by itself when it is back", async () => {
    const port = await freePort();
    let database = await startLocalPostgres({ port });
    await migrate(database.url);
    const app = await createApp({ config: config(database.url), logLevels: [] });
    await app.listen(0, "127.0.0.1");
    const api = new Api(`http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`);
    try {
      expect((await api.get("/v1/circuits")).status).toBe(200);

      await database.stop();
      const down = await api.get("/v1/circuits");
      expect([down.status, down.body.code, down.headers.get("retry-after")]).toEqual([503, "server-unavailable", "5"]);
      const health = await api.get("/health");
      expect([health.status, health.body.storage]).toEqual([503, { kind: "postgresql", reachable: false }]);

      database = await startLocalPostgres({ port }); // a new, empty server on the same address
      await migrate(database.url);
      expect((await api.get("/v1/circuits")).status).toBe(200);
    } finally {
      await app.close();
      await database.stop();
    }
  }, 60_000);
});
