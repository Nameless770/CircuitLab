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
