// openapi.yaml and the code that enforces it must agree: these tests catch a number changed in one
// place but not the other.

import { CIRCUIT_SORTS, LIMITS, PROBLEM_TYPES, allOperations, openApi } from "@circuitlab/api-contract";
import { GATE_TYPES, MAX_GATE_INPUTS } from "@circuitlab/engine";
import { describe, expect, it } from "vitest";

// The parsed document, loosely typed: these tests walk into it.
const spec = openApi as unknown as { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any>; parameters: Record<string, any> } };
const { schemas, parameters } = spec.components;

describe("openapi.yaml and the code agree", () => {
  it("on circuit limits", () => {
    expect(schemas.CircuitInput.properties.gates.maxItems).toBe(LIMITS.maxGates);
    expect(schemas.CircuitInput.properties.wires.maxItems).toBe(LIMITS.maxWires);
    expect(schemas.Wire.properties.toPin.maximum).toBe(MAX_GATE_INPUTS - 1);
    expect(Object.keys(schemas.Gate.discriminator.mapping).sort()).toEqual([...GATE_TYPES].sort());
  });

  it("on paging limits and sort orders", () => {
    expect(parameters.PageLimit.schema).toMatchObject({ maximum: LIMITS.circuitsPerPage.max, default: LIMITS.circuitsPerPage.default });
    expect(parameters.RowLimit.schema.maximum).toBe(LIMITS.maxStreamedRows);
    expect(parameters.RowOffset.schema.maximum).toBe(Number.MAX_SAFE_INTEGER);
    expect(parameters.CircuitSort.schema.enum).toEqual([...CIRCUIT_SORTS]);
    expect(parameters.ListScope.schema.enum).toEqual(["owned", "shared", "public"]);
  });

  it("on the password rules", () => {
    expect(schemas.Password).toMatchObject({ minLength: LIMITS.password.minLength, maxLength: LIMITS.password.maxLength });
    expect(schemas.SignInRequest.properties.password.maxLength).toBe(LIMITS.password.maxLength);
  });

  it("on every problem code (client-closed-request is never sent, so it isn't documented)", () => {
    const documented = [...schemas.Problem.properties.code.enum].sort();
    expect(documented).toEqual(Object.keys(PROBLEM_TYPES).filter((code) => code !== "client-closed-request").sort());
  });

  it("on which operations need a token", () => {
    const needsToken = allOperations()
      .filter((operation) => {
        const security = spec.paths[operation.path]?.[operation.method.toLowerCase()]?.security as unknown[] | undefined;
        return security !== undefined && security.length === 1;
      })
      .map((operation) => operation.id)
      .sort();
    expect(needsToken).toEqual(
      ["createCircuit", "deleteCircuit", "getCurrentUser", "listRuns", "listShares", "replaceCircuit", "shareCircuit", "unshareCircuit", "updateCircuitMetadata"].sort(),
    );
  });

  it("documents a 401 wherever a token is accepted: a bad one is refused even where none is needed", () => {
    for (const operation of allOperations()) {
      const definition = spec.paths[operation.path]?.[operation.method.toLowerCase()];
      const acceptsToken = definition?.security === undefined || definition.security.length > 0; // `security: []` ignores tokens
      if (acceptsToken) expect(Object.keys(definition?.responses ?? {}), operation.id).toContain("401");
    }
  });

  it("documents a 503 for every operation, since every one uses the database", () => {
    for (const operation of allOperations()) {
      expect(Object.keys(spec.paths[operation.path]?.[operation.method.toLowerCase()]?.responses ?? {}), operation.id).toContain("503");
    }
  });
});
