import {
  ApiError,
  bearerToken,
  forbidden,
  invalidCredentials,
  invalidToken,
  normalizeEmail,
  normalizePassword,
  toProblem,
  tooManySignInAttempts,
  unauthenticated,
} from "@circuitlab/api-contract";
import { CircuitValidationError, compileCircuit } from "@circuitlab/engine";
import { NetlistError } from "@circuitlab/netlist";
import { PoolBusyError, PoolClosedError, WorkerCrashedError } from "@circuitlab/runner";
import { describe, expect, it } from "vitest";
import { expectConforms, thrown } from "./helpers";

const outOfMemory = Object.assign(new Error("oom"), { code: "ERR_WORKER_OUT_OF_MEMORY" });

describe("toProblem: every error becomes one RFC 9457 response", () => {
  it.each<[string, unknown, number, string, Record<string, string>]>([
    ["an engine validation error", new CircuitValidationError([{ code: "DUPLICATE_GATE_ID", message: "x", gateId: "A", gateIndex: 1 }]), 422, "invalid-circuit", {}],
    ["a feedback loop", thrown(() => compileCircuit({ gates: [{ id: "q", type: "NOT" }], wires: [{ from: "q", to: "q", toPin: 0 }] })), 422, "feedback-loop", {}],
    ["a netlist error", new NetlistError([{ code: "SYNTAX_ERROR", message: "x", line: 1, column: 2 }]), 422, "invalid-netlist", {}],
    ["a full pool", new PoolBusyError(0), 503, "server-busy", { "Retry-After": "1" }],
    ["a closed pool", new PoolClosedError(), 503, "server-unavailable", { "Retry-After": "5" }],
    ["a timeout", new DOMException("late", "TimeoutError"), 503, "simulation-timeout", {}],
    ["a worker out of memory", new WorkerCrashedError("x", { cause: outOfMemory }), 422, "computation-too-large", {}],
    ["a worker crashing otherwise", new WorkerCrashedError("exit 1"), 500, "internal-error", {}],
    ["a client gone", new DOMException("gone", "AbortError"), 499, "client-closed-request", {}],
    ["a missing token", unauthenticated(), 401, "unauthenticated", { "WWW-Authenticate": 'Bearer realm="circuitlab"' }],
    ["a bad token", invalidToken("x"), 401, "invalid-token", { "WWW-Authenticate": 'Bearer realm="circuitlab", error="invalid_token"' }],
    ["a failed sign-in", invalidCredentials(), 401, "invalid-credentials", { "WWW-Authenticate": 'Bearer realm="circuitlab"' }],
    ["a forbidden action", forbidden("no"), 403, "forbidden", {}],
    ["too many sign-ins", tooManySignInAttempts(840), 429, "too-many-requests", { "Retry-After": "840" }],
    ["an ApiError", new ApiError("not-found", "No circuit."), 404, "not-found", {}],
    ["a bug", new TypeError("Cannot read properties of undefined (reading 'secret')"), 500, "internal-error", {}],
    ["a thrown string", "a string", 500, "internal-error", {}],
  ])("%s", (_, error, status, code, headers) => {
    const problem = toProblem(error, "/v1/circuits/c1/simulate");
    expect(problem.status).toBe(status);
    expect(problem.body).toMatchObject({ code, status, type: `/problems/${code}`, instance: "/v1/circuits/c1/simulate" });
    expect(problem.headers).toMatchObject({ "Content-Type": "application/problem+json", ...headers });
    expect(JSON.stringify(problem.body)).not.toContain("secret"); // internals never leak
    if (code !== "client-closed-request") expectConforms("Problem", problem.body);
  });
});

describe("reading credentials", () => {
  it.each(["Bearer abc.def-ghi_jkl", "bearer abc", "Bearer   abc  ", "Bearer a+b/c=="])("accepts %j", (header) => {
    expect(bearerToken(header)).toMatch(/^a/);
  });

  it.each(["Basic dXNlcg==", "Bearer", "Bearer two tokens", "abc", "Bearer <script>"])("refuses %j with 401 invalid-token", (header) => {
    expect(toProblem(thrown(() => bearerToken(header))).body.code).toBe("invalid-token");
  });

  it("compares email addresses in lower case, without surrounding spaces", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  it("treats a password typed with composed or combining accents as the same password (NFKC)", () => {
    expect(normalizePassword("café au lait, s'il vous plaît")).toBe(normalizePassword("café au lait, s'il vous plaît"));
  });
});
