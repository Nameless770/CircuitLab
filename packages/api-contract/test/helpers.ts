import { toProblem, validateAgainstSchema, type CircuitRecord, type ProblemResponse } from "@circuitlab/api-contract";
import { summarizeCircuit } from "@circuitlab/api-contract";
import { expect } from "vitest";
import { halfAdder } from "../../engine/test/fixtures";

/** What `fn` throws; fails the test if it returns. */
export function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected an error to be thrown");
}

/** The HTTP response the API would send for what `fn` throws. */
export function problemOf(fn: () => unknown, instance?: string): ProblemResponse {
  return toProblem(thrown(fn), instance);
}

/** Each issue as "CODE@location", the location being a pointer, a parameter, or line:column. */
export function issuesAt(problem: ProblemResponse): string[] {
  return (problem.body.issues ?? []).map((issue) => `${issue.code}@${issue.pointer ?? issue.parameter ?? `${issue.line}:${issue.column ?? ""}`}`);
}

/** Asserts that `value`, as JSON, matches the openapi.yaml schema of that name. */
export function expectConforms(schema: string, value: unknown): void {
  expect(validateAgainstSchema(schema, JSON.parse(JSON.stringify(value))), `${schema}`).toEqual([]);
}

/** A stored circuit, as storage would hand it over. */
export function record(overrides: Partial<CircuitRecord> = {}): CircuitRecord {
  const base = {
    id: "c1",
    version: 3,
    createdAt: new Date("2026-10-01T10:00:00Z"),
    updatedAt: new Date("2026-10-01T11:00:00Z"),
    description: null,
    owner: { id: "u1", displayName: "Ada" },
    visibility: "private" as const,
    ...halfAdder(),
    name: "Half adder",
    ...overrides,
  };
  return { ...base, summary: summarizeCircuit(base) };
}
