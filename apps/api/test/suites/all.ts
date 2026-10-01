import { allOperations } from "@circuitlab/api-contract";
import { describe, expect, it } from "vitest";
import { useServer, type Storage } from "../support/server";
import { accessSuite } from "./access";
import { accountsSuite } from "./accounts";
import { circuitsSuite } from "./circuits";
import { sharingSuite } from "./sharing";
import { simulationSuite } from "./simulation";

/** The whole API, over HTTP, against one kind of storage. */
export function describeApi(storage: Storage): void {
  const context = useServer(storage);

  describe("the server", () => {
    it("reports its health and its storage", async () => {
      const reply = await context().api.get("/health");
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({ status: "ok", storage: { kind: storage } });
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
  sharingSuite(context);

  // Last: every operation in openapi.yaml was called at least once with a success status.
  it("exercises every operation in openapi.yaml", () => {
    const succeeded = new Set([...context().api.exercised].filter((entry) => / 2\d\d$/.test(entry)).map((entry) => entry.split(" ")[0]));
    expect(allOperations().map((operation) => operation.id).filter((id) => !succeeded.has(id))).toEqual([]);
  });
}
