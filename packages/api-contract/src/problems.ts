// Turns any error into an RFC 9457 problem response. One mapping, used by every endpoint, so the
// same failure always produces the same status, type, and shape.

import {
  CircuitValidationError,
  CycleError,
  OscillationError,
  SimulationInputError,
  type InputIssue,
  type ValidationIssue,
  type ValidationIssueCode,
} from "@circuitlab/engine";
import { NetlistError } from "@circuitlab/netlist";
import { PoolBusyError, PoolClosedError, WorkerCrashedError } from "@circuitlab/runner";
import { LIMITS } from "./limits";

/** Every kind of problem the API reports. The key is the `code`; `type` is `/problems/<code>`. */
export const PROBLEM_TYPES = {
  "invalid-request": { status: 400, title: "Invalid request" },
  "malformed-body": { status: 400, title: "Malformed request body" },
  "unauthenticated": { status: 401, title: "Sign-in required" },
  "invalid-token": { status: 401, title: "Invalid or expired token" },
  "invalid-credentials": { status: 401, title: "Wrong email or password" },
  "forbidden": { status: 403, title: "Not allowed" },
  "not-found": { status: 404, title: "Not found" },
  "not-acceptable": { status: 406, title: "Not acceptable" },
  "email-taken": { status: 409, title: "Email already registered" },
  "version-conflict": { status: 409, title: "Circuit changed" },
  "precondition-failed": { status: 412, title: "Precondition failed" },
  "content-too-large": { status: 413, title: "Content too large" },
  "unsupported-media-type": { status: 415, title: "Unsupported media type" },
  "invalid-circuit": { status: 422, title: "Invalid circuit" },
  "invalid-netlist": { status: 422, title: "Invalid netlist" },
  "invalid-inputs": { status: 422, title: "Invalid simulation inputs" },
  "feedback-loop": { status: 422, title: "Circuit has a feedback loop" },
  "too-many-inputs": { status: 422, title: "Too many inputs for a truth table" },
  "computation-too-large": { status: 422, title: "Computation too large" },
  "does-not-settle": { status: 422, title: "Circuit does not settle" },
  "invalid-fields": { status: 422, title: "Invalid fields" },
  "too-many-requests": { status: 429, title: "Too many requests" },
  // Never sent (the client has gone), but gives logs a status: nginx's convention.
  "client-closed-request": { status: 499, title: "Client closed request" },
  "internal-error": { status: 500, title: "Internal server error" },
  "server-busy": { status: 503, title: "Server busy" },
  "server-unavailable": { status: 503, title: "Server unavailable" },
  "simulation-timeout": { status: 503, title: "Simulation timed out" },
} as const satisfies Record<string, { readonly status: number; readonly title: string }>;

export type ProblemCode = keyof typeof PROBLEM_TYPES;

/** One validation problem. Usually exactly one location field is set. */
export interface ProblemIssue {
  readonly code: string;
  readonly message: string;
  /** RFC 6901 JSON Pointer into the JSON request body, e.g. "/gates/3/type". */
  readonly pointer?: string;
  /** The query parameter at fault. */
  readonly parameter?: string;
  /** Position in a netlist body. */
  readonly line?: number;
  readonly column?: number;
  /** The gate involved, when there is one, so a UI can highlight it. */
  readonly gateId?: string;
  readonly pin?: number;
}

/** An RFC 9457 problem document. */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: ProblemCode;
  readonly detail?: string;
  readonly instance?: string;
  readonly issues?: readonly ProblemIssue[];
  readonly cycle?: readonly string[];
}

export interface ProblemResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Problem;
}

interface ProblemExtras {
  readonly issues?: readonly ProblemIssue[];
  readonly cycle?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
}

/** An error raised by the API layer itself (not found, bad parameter, ...), already classified. */
export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly code: ProblemCode,
    readonly detail: string,
    readonly extras: ProblemExtras = {},
  ) {
    super(detail);
  }
}

/**
 * Maps any thrown value to the response to send. Unknown errors become a 500 whose body reveals
 * nothing about them; log the original (status >= 500 is a good rule for what to log).
 *
 * @param instance the request path, echoed back so a client can tell which call failed
 */
export function toProblem(error: unknown, instance?: string): ProblemResponse {
  const respond = (code: ProblemCode, detail: string, extras: ProblemExtras = {}): ProblemResponse => {
    const { status, title } = PROBLEM_TYPES[code];
    const body: Problem = {
      type: `/problems/${code}`,
      title,
      status,
      code,
      detail,
      ...(instance !== undefined && { instance }),
      ...(extras.issues !== undefined && { issues: extras.issues.slice(0, LIMITS.maxIssues) }),
      ...(extras.cycle !== undefined && { cycle: extras.cycle }),
    };
    return { status, headers: { "Content-Type": "application/problem+json", ...extras.headers }, body };
  };

  if (error instanceof ApiError) return respond(error.code, error.detail, error.extras);

  // Problems with what the client sent: 422, with every issue located.
  if (error instanceof NetlistError) {
    const issues = error.issues.map(({ code, message, line, column }) => ({ code, message, line, ...(column !== undefined && { column }) }));
    return respond("invalid-netlist", `The netlist has ${count(issues.length, "problem")}.`, { issues });
  }
  if (error instanceof CircuitValidationError) {
    return respond("invalid-circuit", `The circuit has ${count(error.issues.length, "problem")}.`, { issues: error.issues.map(circuitIssue) });
  }
  if (error instanceof SimulationInputError) {
    return respond("invalid-inputs", `The inputs have ${count(error.issues.length, "problem")}.`, { issues: error.issues.map(inputIssue) });
  }
  if (error instanceof CycleError) {
    const loop = error.cycle.join(" -> ");
    return respond("feedback-loop", `The circuit has a feedback loop (${loop}), so it has no combinational evaluation order.`, {
      cycle: error.cycle,
    });
  }

  if (error instanceof OscillationError) {
    return respond("does-not-settle", `The loop of gates ${error.gates.join(", ")} keeps changing instead of settling, so it has no stable state.`, {
      issues: error.gates.map((gateId) => ({ code: "DOES_NOT_SETTLE", message: "keeps changing", gateId })),
    });
  }

  // The simulation workers: overload is temporary (503 + Retry-After); running out of memory is not.
  if (error instanceof PoolBusyError) {
    return respond("server-busy", "Every simulation worker is busy. Try again shortly.", {
      headers: { "Retry-After": String(LIMITS.retryAfterSeconds.busy) },
    });
  }
  if (error instanceof PoolClosedError) {
    return respond("server-unavailable", "The server is shutting down. Try again shortly.", {
      headers: { "Retry-After": String(LIMITS.retryAfterSeconds.unavailable) },
    });
  }
  if (error instanceof WorkerCrashedError && errorCode(error.cause) === "ERR_WORKER_OUT_OF_MEMORY") {
    return respond("computation-too-large", "The request needed more memory than one simulation may use. Ask for fewer rows.");
  }

  // Cancellation, standard DOMException names from AbortSignal.
  if (errorName(error) === "TimeoutError") {
    const seconds = LIMITS.simulationTimeoutMs / 1000;
    return respond("simulation-timeout", `The simulation did not finish within ${seconds} seconds. Try a smaller request, or later.`);
  }
  if (errorName(error) === "AbortError") return respond("client-closed-request", "The client disconnected before the answer was ready.");

  return respond("internal-error", "Something went wrong on our side. It has been logged.");
}

// Which field of a gate or wire each engine issue is about, to point at it precisely.
const GATE_FIELDS: Partial<Record<ValidationIssueCode, string>> = {
  DUPLICATE_GATE_ID: "id",
  UNKNOWN_GATE_TYPE: "type",
  INVALID_CONST_VALUE: "value",
};
const WIRE_FIELDS: Partial<Record<ValidationIssueCode, string>> = {
  DUPLICATE_WIRE_ID: "id",
  UNKNOWN_SOURCE_GATE: "from",
  OUTPUT_AS_SOURCE: "from",
  UNKNOWN_TARGET_GATE: "to",
  PIN_OUT_OF_RANGE: "toPin",
  MULTIPLE_DRIVERS: "toPin",
};

/** An engine validation issue, located by JSON Pointer in the circuit body. */
export function circuitIssue(issue: ValidationIssue): ProblemIssue {
  const { code, message, gateId, gateIndex, wireIndex, pin } = issue;
  let pointer: string | undefined;
  if (wireIndex !== undefined) pointer = `/wires/${wireIndex}${field(WIRE_FIELDS[code])}`;
  else if (gateIndex !== undefined) pointer = `/gates/${gateIndex}${field(GATE_FIELDS[code])}`;
  return {
    code,
    message,
    ...(pointer !== undefined && { pointer }),
    ...(gateId !== undefined && { gateId }),
    ...(pin !== undefined && { pin }),
  };
}

/** An input or state problem, located in the simulate request's body. */
function inputIssue({ code, message, inputId, stateGateId }: InputIssue): ProblemIssue {
  if (stateGateId !== undefined) return { code, message, pointer: `/state/${escapePointer(stateGateId)}`, gateId: stateGateId };
  if (code === "MALFORMED_STATE") return { code, message, pointer: "/state" };
  return { code, message, pointer: inputId === undefined ? "/inputs" : `/inputs/${escapePointer(inputId)}` };
}

/** Escapes one JSON Pointer segment (RFC 6901): "~" becomes "~0", "/" becomes "~1". */
export function escapePointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

const field = (name: string | undefined): string => (name === undefined ? "" : `/${name}`);
const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

function errorName(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" ? error.name : undefined;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
