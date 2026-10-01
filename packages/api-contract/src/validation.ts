// Request validation, driven by openapi.yaml: the spec's schemas are compiled with Ajv and used as
// they are, so the documented rules and the enforced rules are literally the same rules. The
// engine then checks what a schema can't express (dangling wires, pin counts, duplicates, ...).

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import { GATE_TYPES, assertValidCircuit, type Circuit } from "@circuitlab/engine";
import type { CircuitInput, CircuitMetadataPatch, ListScope, RefreshRequest, RegisterRequest, ShareRequest, SignInRequest, SimulateRequest } from "./dto";
import { LIMITS } from "./limits";
import { decodeCursor, type CircuitCursor, type CircuitSort } from "./pagination";
import { ApiError, escapePointer, type ProblemCode, type ProblemIssue } from "./problems";
import { openApi, operation } from "./spec";

const SCHEMAS = "openapi.json";

/**
 * The spec's component schemas, adapted for Ajv: references point into one registered document,
 * and each discriminator loses its `mapping`, which only documentation tools need (Ajv reads each
 * branch's `const` or `enum` instead).
 */
const schemaDocument = { $id: SCHEMAS, $defs: adapt(openApi.components.schemas) };

function adapt(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(adapt);
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") {
      result[key] = child.replace("#/components/schemas/", `${SCHEMAS}#/$defs/`);
    } else if (key === "discriminator" && typeof child === "object" && child !== null && "propertyName" in child) {
      result[key] = { propertyName: child.propertyName };
    } else {
      result[key] = adapt(child);
    }
  }
  return result;
}

const ajvOptions = { allErrors: true, strict: true, validateFormats: false, verbose: true, discriminator: true } as const;
/** For JSON bodies: values are checked exactly as sent. */
const bodies = new Ajv2020(ajvOptions).addSchema(schemaDocument);
/** For query strings: every value arrives as text, so "20" may become 20; defaults are filled in. */
const queries = new Ajv2020({ ...ajvOptions, coerceTypes: true, useDefaults: true }).addSchema(schemaDocument);

// ---------------------------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------------------------

/**
 * Checks a JSON body for creating or replacing a circuit: first against the spec, then with the
 * engine's circuit rules.
 *
 * @throws ApiError `malformed-body` (400) if it isn't a JSON object, `invalid-circuit` (422) otherwise
 * @throws CircuitValidationError for the engine's rules, which `toProblem` also turns into `invalid-circuit`
 */
export function parseCircuitInput(body: unknown): CircuitInput {
  requireObject(body, "a JSON object describing a circuit");
  checkSchema("CircuitInput", body, "invalid-circuit", "The circuit");
  assertValidCircuit(body);
  return body as unknown as CircuitInput;
}

/**
 * Applies the API's rules to a circuit read from a netlist body (with `importNetlist`, which has
 * already applied the engine's). A pointer in an issue then refers to the circuit's JSON form:
 * `/gates/3` is the fourth gate line.
 */
export function circuitInputFromNetlist(circuit: Circuit, query: { readonly name?: string; readonly description?: string }): CircuitInput {
  const name = query.name ?? circuit.name;
  if (name === undefined) {
    throw new ApiError("invalid-netlist", "The circuit needs a name.", {
      issues: [{ code: "REQUIRED", message: 'add a ".name" line to the netlist, or a "name" query parameter', parameter: "name" }],
    });
  }
  const input: CircuitInput = {
    name,
    ...(query.description !== undefined && { description: query.description }),
    gates: circuit.gates,
    wires: circuit.wires,
  };
  checkSchema("CircuitInput", input, "invalid-circuit", "The circuit");
  return input;
}

/** @throws ApiError `malformed-body` (400) or `invalid-circuit` (422) */
export function parseMetadataPatch(body: unknown): CircuitMetadataPatch {
  requireObject(body, "a JSON object with a new name or description");
  checkSchema("CircuitMetadataPatch", body, "invalid-circuit", "The change");
  return body as CircuitMetadataPatch;
}

/**
 * Checks the shape of a simulation request. Input *values* are left to the engine, which checks
 * them together with the names this circuit expects, so every input problem is reported at once.
 *
 * @throws ApiError `malformed-body` (400) or `invalid-inputs` (422)
 */
export function parseSimulateRequest(body: unknown): SimulateRequest {
  requireObject(body, 'a JSON object such as {"inputs": {"A": 1}}');
  // Values in `inputs` and `state` are the engine's to check, together with which keys the circuit has.
  const issues = schemaIssues("SimulateRequest", body).filter((issue) => !/^\/(inputs|state)\//.test(issue.pointer ?? ""));
  if (issues.length > 0) throw new ApiError("invalid-inputs", `The request has ${plural(issues.length, "problem")}.`, { issues });
  const request = body as unknown as { inputs: SimulateRequest["inputs"]; mode?: SimulateRequest["mode"]; state?: SimulateRequest["state"] };
  return { inputs: request.inputs, mode: request.mode ?? "combinational", ...(request.state !== undefined && { state: request.state }) };
}

/** @throws ApiError `malformed-body` (400) or `invalid-fields` (422), e.g. a password under 15 characters */
export function parseRegisterRequest(body: unknown): RegisterRequest {
  requireObject(body, 'a JSON object such as {"email": "ada@example.com", "password": "...", "displayName": "Ada"}');
  checkSchema("RegisterRequest", body, "invalid-fields", "The registration");
  return body as unknown as RegisterRequest;
}

/**
 * Only the shape is checked here, not the password rules: those apply when a password is chosen,
 * and an account must stay reachable even if the rules change later.
 *
 * @throws ApiError `malformed-body` (400) or `invalid-fields` (422)
 */
export function parseSignInRequest(body: unknown): SignInRequest {
  requireObject(body, 'a JSON object such as {"email": "ada@example.com", "password": "..."}');
  checkSchema("SignInRequest", body, "invalid-fields", "The sign-in");
  return body as unknown as SignInRequest;
}

/** For refreshing and for signing out. @throws ApiError `malformed-body` (400) or `invalid-fields` (422) */
export function parseRefreshRequest(body: unknown): RefreshRequest {
  requireObject(body, 'a JSON object such as {"refreshToken": "..."}');
  checkSchema("RefreshRequest", body, "invalid-fields", "The request");
  return body as unknown as RefreshRequest;
}

/** @throws ApiError `malformed-body` (400) or `invalid-fields` (422) */
export function parseShareRequest(body: unknown): ShareRequest {
  requireObject(body, 'a JSON object such as {"email": "bob@example.com", "role": "viewer"}');
  checkSchema("ShareRequest", body, "invalid-fields", "The share");
  return body as unknown as ShareRequest;
}

function requireObject(body: unknown, expected: string): asserts body is Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError("malformed-body", `The body must be ${expected}.`);
  }
}

function checkSchema(schema: string, body: unknown, code: ProblemCode, subject: string): void {
  const issues = schemaIssues(schema, body);
  if (issues.length > 0) throw new ApiError(code, `${subject} has ${plural(issues.length, "problem")}.`, { issues });
}

/**
 * Checks any value against a schema in openapi.yaml, e.g. `validateAgainstSchema("Circuit", body)`.
 * Meant for contract tests: proving that what the server sends matches what the spec promises.
 */
export function validateAgainstSchema(schema: string, value: unknown): readonly ProblemIssue[] {
  return schemaIssues(schema, value);
}

function schemaIssues(schema: string, body: unknown): ProblemIssue[] {
  const validate = bodies.getSchema(`${SCHEMAS}#/$defs/${schema}`);
  if (validate === undefined) throw new Error(`openapi.yaml has no schema "${schema}"`);
  return validate(body) ? [] : describeAll(validate.errors);
}

// ---------------------------------------------------------------------------------------------
// Query strings
// ---------------------------------------------------------------------------------------------

export interface ListCircuitsQuery {
  readonly limit: number;
  readonly sort: CircuitSort;
  /** Absent when the client didn't choose: `owned` if signed in, `public` otherwise. */
  readonly scope?: ListScope;
  readonly cursor?: CircuitCursor;
  readonly q?: string;
}

export function parseListCircuitsQuery(query: unknown): ListCircuitsQuery {
  const values = readQuery("listCircuits", query);
  const sort = values.sort as CircuitSort;
  return {
    limit: values.limit as number,
    sort,
    ...(typeof values.scope === "string" && { scope: values.scope as ListScope }),
    ...(typeof values.cursor === "string" && { cursor: decodeCursor(values.cursor, sort) }),
    ...(typeof values.q === "string" && { q: values.q }),
  };
}

export interface CircuitWriteQuery {
  readonly dryRun: boolean;
  readonly name?: string;
  readonly description?: string;
}

/**
 * Query parameters of createCircuit and replaceCircuit. `name` and `description` only make sense
 * for netlist bodies (JSON bodies carry their own), so they are refused with JSON.
 */
export function parseCircuitWriteQuery(
  operationId: "createCircuit" | "replaceCircuit",
  query: unknown,
  body: "json" | "netlist",
): CircuitWriteQuery {
  const values = readQuery(operationId, query);
  if (body === "json") {
    const misplaced = ["name", "description"].filter((name) => values[name] !== undefined);
    if (misplaced.length > 0) {
      throw new ApiError("invalid-request", "The name and description of a JSON circuit go in the body.", {
        issues: misplaced.map((parameter) => ({ code: "NOT_ALLOWED", message: "only allowed with netlist bodies", parameter })),
      });
    }
  }
  return {
    dryRun: values.dryRun === true,
    ...(typeof values.name === "string" && { name: values.name }),
    ...(typeof values.description === "string" && { description: values.description }),
  };
}

export interface SimulateQuery {
  readonly includeSignals: boolean;
}

export function parseSimulateQuery(query: unknown): SimulateQuery {
  return { includeSignals: readQuery("simulateCircuit", query).include === "signals" };
}

export interface ListRunsQuery {
  readonly limit: number;
}

export function parseListRunsQuery(query: unknown): ListRunsQuery {
  return { limit: readQuery("listRuns", query).limit as number };
}

export interface TruthTableQuery {
  readonly offset: number;
  readonly limit?: number;
  readonly version?: number;
}

export function parseTruthTableQuery(query: unknown): TruthTableQuery {
  const values = readQuery("getTruthTable", query);
  return {
    offset: values.offset as number,
    ...(typeof values.limit === "number" && { limit: values.limit }),
    ...(typeof values.version === "number" && { version: values.version }),
  };
}

/**
 * Validates an operation's query parameters against their schemas in the spec, converting text
 * to numbers and booleans and filling in defaults. Parameters the operation doesn't define are
 * ignored, as is usual for query strings.
 *
 * @throws ApiError `invalid-request` (400) listing every bad parameter
 */
function readQuery(operationId: string, query: unknown): Record<string, unknown> {
  const raw: Readonly<Record<string, unknown>> = typeof query === "object" && query !== null ? (query as Record<string, unknown>) : {};
  const values: Record<string, unknown> = {};
  const issues: ProblemIssue[] = [];
  for (const { name, in: location } of operation(operationId).parameters) {
    if (location !== "query" || !Object.hasOwn(raw, name)) continue;
    const value = raw[name];
    if (typeof value === "string") values[name] = value;
    else issues.push({ code: "INVALID_VALUE", message: Array.isArray(value) ? "must be given only once" : "must be a single value", parameter: name });
  }
  const validate = queryValidator(operationId);
  if (!validate(values)) {
    // In a query, a location is a parameter name rather than a pointer.
    for (const { pointer, ...issue } of describeAll(validate.errors)) {
      issues.push({ ...issue, parameter: (pointer ?? "").split("/")[1] ?? "" });
    }
  }
  if (issues.length > 0) throw new ApiError("invalid-request", `${plural(issues.length, "query parameter problem")}.`, { issues });
  return values;
}

const queryValidators = new Map<string, ValidateFunction>();

function queryValidator(operationId: string): ValidateFunction {
  let validate = queryValidators.get(operationId);
  if (validate === undefined) {
    const parameters = operation(operationId).parameters.filter((parameter) => parameter.in === "query");
    validate = queries.compile({
      type: "object",
      properties: Object.fromEntries(parameters.map((parameter) => [parameter.name, adapt(parameter.schema ?? {})])),
      required: parameters.filter((parameter) => parameter.required === true).map((parameter) => parameter.name),
    });
    queryValidators.set(operationId, validate);
  }
  return validate;
}

// ---------------------------------------------------------------------------------------------
// Turning Ajv's errors into issues a person can act on
// ---------------------------------------------------------------------------------------------

function describeAll(errors: readonly ErrorObject[] | null | undefined): ProblemIssue[] {
  const issues: ProblemIssue[] = [];
  for (const error of errors ?? []) {
    const issue = describe(error);
    if (issue !== undefined) issues.push(issue);
    if (issues.length >= LIMITS.maxIssues) break;
  }
  return issues;
}

function describe(error: ErrorObject): ProblemIssue | undefined {
  const at = error.instancePath;
  const params = error.params as Record<string, unknown>;
  const limit = String(params.limit);
  switch (error.keyword) {
    case "required": {
      const name = String(params.missingProperty);
      return { code: "REQUIRED", message: `"${name}" is required`, pointer: `${at}/${escapePointer(name)}` };
    }
    case "additionalProperties": {
      const name = String(params.additionalProperty);
      const message = name === "value" && /^\/gates\/\d+$/.test(at) ? 'only CONST gates have a "value"' : `unknown field "${name}"`;
      return { code: "UNKNOWN_FIELD", message, pointer: `${at}/${escapePointer(name)}` };
    }
    case "discriminator": {
      // The only discriminated union in the spec is Gate, told apart by `type`.
      const pointer = `${at}/${escapePointer(String(params.tag))}`;
      if (params.error === "mapping") {
        const expected = GATE_TYPES.join(", ");
        return { code: "UNKNOWN_GATE_TYPE", message: `unknown gate type ${JSON.stringify(params.tagValue)} (expected one of ${expected})`, pointer };
      }
      return params.tagValue === undefined
        ? { code: "REQUIRED", message: `"${String(params.tag)}" is required`, pointer }
        : { code: "INVALID_TYPE", message: "must be a string", pointer };
    }
    case "type":
      return { code: "INVALID_TYPE", message: `must be ${String(params.type).split(",").map(typeName).join(" or ")}`, pointer: at };
    case "enum":
      return { code: "INVALID_VALUE", message: `must be one of ${(params.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(", ")}`, pointer: at };
    case "const":
      return { code: "INVALID_VALUE", message: `must be ${JSON.stringify(params.allowedValue)}`, pointer: at };
    case "pattern": {
      const title = (error.parentSchema as { title?: unknown } | undefined)?.title;
      return { code: "INVALID_FORMAT", message: `must be ${typeof title === "string" ? title : `in the format ${String(params.pattern)}`}`, pointer: at };
    }
    case "minLength":
      return limit === "1" ? { code: "REQUIRED", message: "must not be empty", pointer: at } : { code: "TOO_SHORT", message: `must be at least ${limit} characters`, pointer: at };
    case "maxLength":
      return { code: "TOO_LONG", message: `must be at most ${limit} characters`, pointer: at };
    case "maxItems":
      return { code: "TOO_MANY_ITEMS", message: `must have at most ${Number(limit).toLocaleString("en")} items`, pointer: at };
    case "minimum":
      return { code: "OUT_OF_RANGE", message: `must be at least ${limit}`, pointer: at };
    case "maximum":
      return { code: "OUT_OF_RANGE", message: `must be at most ${Number(limit).toLocaleString("en")}`, pointer: at };
    case "minProperties":
      return { code: "EMPTY", message: "must contain at least one field", pointer: at };
    case "if":
    case "oneOf":
    case "anyOf":
      return undefined; // summaries of other errors, which are reported themselves
    default:
      return { code: "INVALID_VALUE", message: error.message ?? "is invalid", pointer: at };
  }
}

function typeName(type: string): string {
  switch (type) {
    case "object":
      return "an object";
    case "array":
      return "an array";
    case "integer":
      return "a whole number";
    case "boolean":
      return "true or false";
    case "null":
      return "null";
    default:
      return `a ${type}`;
  }
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;
