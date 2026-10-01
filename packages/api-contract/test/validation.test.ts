import {
  circuitInputFromNetlist,
  openApi,
  parseCircuitInput,
  parseCircuitWriteQuery,
  parseListCircuitsQuery,
  parseListRunsQuery,
  parseMetadataPatch,
  parseRefreshRequest,
  parseRegisterRequest,
  parseShareRequest,
  parseSignInRequest,
  parseSimulateQuery,
  parseSimulateRequest,
  parseTruthTableQuery,
  toProblem,
} from "@circuitlab/api-contract";
import { simulate } from "@circuitlab/engine";
import { parseNetlist } from "@circuitlab/netlist";
import { describe, expect, it } from "vitest";
import { halfAdder } from "../../engine/test/fixtures";
import { expectConforms, issuesAt, problemOf, thrown } from "./helpers";

const HALF = { ...halfAdder(), name: "Half adder" };

describe("circuit bodies", () => {
  it("accept a valid circuit, the spec's own example, and a circuit with a loop (valid structure)", () => {
    expect(parseCircuitInput(structuredClone(HALF))).toEqual(HALF);
    parseCircuitInput((openApi.components.schemas as any).CircuitInput.examples[0]);
    const latch = { name: "latch", gates: [{ id: "q", type: "NOT" }], wires: [{ from: "q", to: "q", toPin: 0 }] };
    expect(parseCircuitInput(latch)).toBe(latch);
  });

  it("locate every schema problem by JSON Pointer, with a readable message", () => {
    const body = {
      name: "   ",
      extra: 1,
      description: 5,
      gates: [
        { id: "k", type: "CONST" },
        { id: "a", type: "AND", value: 1 },
        { id: "b", type: "MAJORITY" },
        { id: ".x", type: "OR" },
        { id: "n" },
        "str",
        { id: "L", type: "BUF", label: "x".repeat(201) },
        { id: "t", type: 7 },
      ],
      wires: [{ from: "a", to: "b", toPin: 64 }, { from: "a", to: "b", toPin: -1, color: "red" }, { to: "b", toPin: 0 }],
    };
    const problem = problemOf(() => parseCircuitInput(body));
    expect(problem.status).toBe(422);
    const byPointer = Object.fromEntries((problem.body.issues ?? []).map((issue) => [issue.pointer, `${issue.code}: ${issue.message}`]));
    expect(byPointer).toEqual({
      "/extra": 'UNKNOWN_FIELD: unknown field "extra"',
      "/name": "INVALID_FORMAT: must be a name that is not blank, at most 200 characters",
      "/description": "INVALID_TYPE: must be a string",
      "/gates/0/value": 'REQUIRED: "value" is required',
      "/gates/1/value": 'UNKNOWN_FIELD: only CONST gates have a "value"',
      "/gates/2/type": expect.stringMatching(/^UNKNOWN_GATE_TYPE: unknown gate type "MAJORITY" \(expected one of INPUT, OUTPUT, CONST/),
      "/gates/3/id": 'INVALID_FORMAT: must be a gate name (letters, digits, and _ . $ [ ]; not starting with "."; at most 64 characters)',
      "/gates/4/type": 'REQUIRED: "type" is required',
      "/gates/5": "INVALID_TYPE: must be an object",
      "/gates/6/label": "TOO_LONG: must be at most 200 characters",
      "/gates/7/type": "INVALID_TYPE: must be a string",
      "/wires/0/toPin": "OUT_OF_RANGE: must be at most 63",
      "/wires/1/toPin": "OUT_OF_RANGE: must be at least 0",
      "/wires/1/color": 'UNKNOWN_FIELD: unknown field "color"',
      "/wires/2/from": 'REQUIRED: "from" is required',
    });
    expectConforms("Problem", problem.body);
  });

  it("then apply the engine's rules, located the same way", () => {
    const body = { name: "x", gates: [{ id: "a", type: "INPUT" }, { id: "a", type: "AND" }], wires: [{ from: "ghost", to: "a", toPin: 0 }] };
    expect(issuesAt(problemOf(() => parseCircuitInput(body)))).toEqual(["DUPLICATE_GATE_ID@/gates/1/id", "UNKNOWN_SOURCE_GATE@/wires/0/from", "PIN_OUT_OF_RANGE@/wires/0/toPin"]);
  });

  it.each([null, [], "text", 5])("answer 400 for %j, which isn't an object at all", (body) => {
    expect(problemOf(() => parseCircuitInput(body)).body.code).toBe("malformed-body");
  });

  it("report too many gates as one issue, not 10,001", () => {
    const many = { name: "big", gates: Array.from({ length: 10_001 }, (_, k) => ({ id: `g${k}`, type: "INPUT" })), wires: [] };
    const problem = problemOf(() => parseCircuitInput(many));
    expect(issuesAt(problem)).toEqual(["TOO_MANY_ITEMS@/gates"]);
    expect(problem.body.issues?.[0]?.message).toBe("must have at most 10,000 items");
  });
});

describe("netlist bodies", () => {
  it("take the name from the query, else the file; a description only from the query", () => {
    const parsed = parseNetlist('.name "From file"\nA = INPUT\nY = OUTPUT(A)');
    expect(circuitInputFromNetlist(parsed, {}).name).toBe("From file");
    expect(circuitInputFromNetlist(parsed, { name: "Override" }).name).toBe("Override");
    expect(circuitInputFromNetlist(parsed, { description: "d" }).description).toBe("d");
    expect(issuesAt(problemOf(() => circuitInputFromNetlist(parseNetlist("A = INPUT"), {})))).toEqual(["REQUIRED@name"]);
  });

  it("apply the API's limits to what the file contains", () => {
    const longLabel = parseNetlist(`A = INPUT "${"x".repeat(250)}"`);
    expect(issuesAt(problemOf(() => circuitInputFromNetlist(longLabel, { name: "n" })))).toEqual(["TOO_LONG@/gates/0/label"]);
  });

  it("report the reader's problems at line and column", () => {
    const problem = problemOf(() => parseNetlist("x = NOPE"));
    expect(problem.status).toBe(422);
    expect(issuesAt(problem)).toEqual(["UNKNOWN_GATE_TYPE@1:5"]);
  });
});

describe("other bodies", () => {
  it("metadata patches follow JSON Merge Patch, including visibility", () => {
    expect(parseMetadataPatch({ description: null })).toEqual({ description: null });
    expect(parseMetadataPatch({ visibility: "public" })).toEqual({ visibility: "public" });
    expect(issuesAt(problemOf(() => parseMetadataPatch({})))).toEqual(["EMPTY@"]);
    expect(issuesAt(problemOf(() => parseMetadataPatch({ gates: [] })))).toEqual(["UNKNOWN_FIELD@/gates"]);
    expect(issuesAt(problemOf(() => parseMetadataPatch({ visibility: "friends" })))).toEqual(["INVALID_VALUE@/visibility"]);
  });

  it("simulate requests leave input values to the engine, so every input problem is reported together", () => {
    expect(parseSimulateRequest({ inputs: { A: "1", Q: 1 } })).toEqual({ inputs: { A: "1", Q: 1 }, mode: "combinational" });
    expect(issuesAt(problemOf(() => parseSimulateRequest({ input: {} }))).sort()).toEqual(["REQUIRED@/inputs", "UNKNOWN_FIELD@/input"]);
    const problem = toProblem(thrown(() => simulate(HALF, { A: "1", Q: 1 } as never)));
    expect(issuesAt(problem)).toEqual(["INVALID_INPUT_VALUE@/inputs/A", "MISSING_INPUT@/inputs/B", "UNKNOWN_INPUT@/inputs/Q"]);
    const odd = toProblem(thrown(() => simulate({ gates: [{ id: "a/b~c", type: "INPUT" }], wires: [] }, {})));
    expect(odd.body.issues?.[0]?.pointer).toBe("/inputs/a~1b~0c"); // RFC 6901 escaping
  });
});

describe("account and sharing bodies", () => {
  const register = { email: "ada@example.com", password: "correct horse battery staple", displayName: "Ada" };

  it("registration checks the address, the password length, and the name, all at once", () => {
    expect(parseRegisterRequest(register)).toEqual(register);
    const problem = problemOf(() => parseRegisterRequest({ email: "ada", password: "short", displayName: "  ", admin: true }));
    expect(problem.status).toBe(422);
    expect(problem.body.code).toBe("invalid-fields");
    expect(issuesAt(problem).sort()).toEqual(["INVALID_FORMAT@/displayName", "INVALID_FORMAT@/email", "TOO_SHORT@/password", "UNKNOWN_FIELD@/admin"]);
  });

  it("counts password length in characters, not UTF-16 code units", () => {
    expect(() => parseRegisterRequest({ ...register, password: "🔒".repeat(15) })).not.toThrow();
    expect(issuesAt(problemOf(() => parseRegisterRequest({ ...register, password: "🔒".repeat(14) })))).toEqual(["TOO_SHORT@/password"]);
    expect(issuesAt(problemOf(() => parseRegisterRequest({ ...register, password: "x".repeat(257) })))).toEqual(["TOO_LONG@/password"]);
  });

  it("signing in checks only the shape: an old, shorter password must still work", () => {
    expect(parseSignInRequest({ email: "ada@example.com", password: "old pass" })).toEqual({ email: "ada@example.com", password: "old pass" });
    expect(issuesAt(problemOf(() => parseSignInRequest({ email: "ada@example.com" })))).toEqual(["REQUIRED@/password"]);
  });

  it("refresh and share bodies", () => {
    expect(parseRefreshRequest({ refreshToken: "t" })).toEqual({ refreshToken: "t" });
    expect(issuesAt(problemOf(() => parseRefreshRequest({ refreshToken: "" })))).toEqual(["REQUIRED@/refreshToken"]);
    expect(parseShareRequest({ email: "bob@example.com", role: "editor" })).toEqual({ email: "bob@example.com", role: "editor" });
    expect(issuesAt(problemOf(() => parseShareRequest({ email: "bob@example.com", role: "owner" })))).toEqual(["INVALID_VALUE@/role"]);
  });
});

describe("query strings", () => {
  it("are converted from text, with defaults filled in, and unknown parameters ignored", () => {
    expect(parseListCircuitsQuery({})).toEqual({ limit: 20, sort: "-createdAt" });
    expect(parseListCircuitsQuery({ limit: "5", sort: "name", q: "add", scope: "public", unknown: "x" })).toEqual({ limit: 5, sort: "name", q: "add", scope: "public" });
    expect(parseTruthTableQuery({ offset: "8", limit: "4", version: "2" })).toEqual({ offset: 8, limit: 4, version: 2 });
    expect(parseSimulateQuery({ include: "signals" })).toEqual({ includeSignals: true });
    expect(parseListRunsQuery({})).toEqual({ limit: 20 });
  });

  it("refuse repeated, nested, and out-of-range values, naming each parameter", () => {
    const problem = problemOf(() => parseListCircuitsQuery({ limit: ["1", "2"], sort: "oldest", q: { $ne: 1 }, scope: "mine" }));
    expect(problem.status).toBe(400);
    expect(issuesAt(problem).sort()).toEqual(["INVALID_VALUE@limit", "INVALID_VALUE@q", "INVALID_VALUE@scope", "INVALID_VALUE@sort"]);
    for (const [query, expected] of [
      [{ limit: "0" }, "OUT_OF_RANGE@limit"],
      [{ limit: "101" }, "OUT_OF_RANGE@limit"],
      [{ limit: "abc" }, "INVALID_TYPE@limit"],
      [{ limit: "2.5" }, "INVALID_TYPE@limit"],
    ] as const) {
      expect(issuesAt(problemOf(() => parseListCircuitsQuery(query))), JSON.stringify(query)).toEqual([expected]);
    }
  });

  it("allow name and description only with netlist bodies", () => {
    expect(parseCircuitWriteQuery("createCircuit", { dryRun: "true" }, "json")).toEqual({ dryRun: true });
    expect(parseCircuitWriteQuery("createCircuit", { name: "n", description: "d" }, "netlist")).toEqual({ dryRun: false, name: "n", description: "d" });
    expect(issuesAt(problemOf(() => parseCircuitWriteQuery("createCircuit", { name: "n" }, "json")))).toEqual(["NOT_ALLOWED@name"]);
  });
});
