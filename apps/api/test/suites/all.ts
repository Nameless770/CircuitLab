import { allOperations } from "@circuitlab/api-contract";
import { describe, expect, it } from "vitest";
import { useServer, type Setup } from "../support/server";
import { accessSuite } from "./access";
import { accountsSuite } from "./accounts";
import { cachingSuite } from "./caching";
import { circuitsSuite } from "./circuits";
import { jobsSuite } from "./jobs";
import { sharingSuite } from "./sharing";
import { sequentialSuite } from "./sequential";
import { simulationSuite } from "./simulation";

/** The whole API, over HTTP, in one setup (memory, or PostgreSQL and Redis). */
export function describeApi(setup: Setup): void {
  const context = useServer(setup);

  describe("the server", () => {
    it("reports its health, its storage, and where its cache and jobs live", async () => {
      const reply = await context().api.get("/health");
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({
        status: "ok",
        storage: setup.storage === "memory" ? { kind: "memory" } : { kind: "postgresql", reachable: true },
        redis: setup.redis ? { kind: "redis", reachable: true } : { kind: "memory" },
      });
    });

    it("answers an unknown path with a problem document", async () => {
      const reply = await context().api.get("/v1/nope");
      expect([reply.status, reply.body.code]).toEqual([404, "not-found"]);
    });

    it("serves its contract at /openapi.json, naming itself as the server", async () => {
      const reply = await context().api.get("/openapi.json");
      expect(reply.status).toBe(200);
      expect(reply.headers.get("content-type")).toMatch(/^application\/json/);
      expect(reply.body).toMatchObject({ openapi: "3.1.0", info: { title: "CircuitLab API" }, servers: [{ url: "/v1" }] });
      const served = Object.values<any>(reply.body.paths).flatMap((item) => Object.values<any>(item).map((operation) => operation?.operationId));
      expect(allOperations().map((operation) => operation.id).filter((id) => !served.includes(id))).toEqual([]);
    });

    it("serves the documentation page, and only the Swagger UI files that it uses", async () => {
      const { api } = context();
      const page = await api.get("/docs");
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toMatch(/^text\/html/);
      expect(page.text).toContain("/docs/assets/swagger-ui-bundle.js");
      const init = await api.get("/docs/init.js");
      expect(init.status).toBe(200);
      expect(init.headers.get("content-type")).toMatch(/javascript/);
      expect(init.text).toContain("/openapi.json");
      const bundle = await api.get("/docs/assets/swagger-ui-bundle.js");
      expect(bundle.status).toBe(200);
      expect(bundle.headers.get("content-type")).toMatch(/javascript/);
      expect(bundle.text.length).toBeGreaterThan(500_000);
      expect((await api.get("/docs/assets/swagger-ui.css")).status).toBe(200);
      // Nothing else in the package's folder is reachable, whatever the path tries.
      for (const other of ["package.json", "index.js", "swagger-ui-bundle.js.map", "..%2Fpackage.json", "%2e%2e%2fpackage.json"]) {
        expect((await api.get(`/docs/assets/${other}`)).status, other).toBe(404);
      }
    });

    it("leads from the root to the documentation, and none of it needs a token, even a bad one", async () => {
      const { api } = context();
      const root = await fetch(`${api.base}/`, { redirect: "manual" });
      expect([root.status, root.headers.get("location")]).toEqual([302, "/docs"]);
      const badToken = { Authorization: "Bearer not-a-token" };
      expect((await api.get("/docs", { headers: badToken })).status).toBe(200);
      expect((await api.get("/openapi.json", { headers: badToken })).status).toBe(200);
    });
  });

  accountsSuite(context);
  accessSuite(context);
  circuitsSuite(context);
  simulationSuite(context);
  sequentialSuite(context);
  sharingSuite(context);
  cachingSuite(context);
  jobsSuite(context);

  // Last: every operation in openapi.yaml was called at least once with a success status.
  it("exercises every operation in openapi.yaml", () => {
    const succeeded = new Set([...context().api.exercised].filter((entry) => / 2\d\d$/.test(entry)).map((entry) => entry.split(" ")[0]));
    expect(allOperations().map((operation) => operation.id).filter((id) => !succeeded.has(id))).toEqual([]);
  });
}
