import { isRecord } from "./internal/util";

/** Problems `validateCircuit` can report. Same derive-the-union pattern as GATE_TYPES. */
export const VALIDATION_ISSUE_CODES = [
  "MALFORMED_CIRCUIT",
  "MALFORMED_GATE",
  "MALFORMED_WIRE",
  "DUPLICATE_GATE_ID",
  "DUPLICATE_WIRE_ID",
  "UNKNOWN_GATE_TYPE",
  "INVALID_CONST_VALUE",
  "UNKNOWN_SOURCE_GATE",
  "UNKNOWN_TARGET_GATE",
  "OUTPUT_AS_SOURCE",
  "PIN_OUT_OF_RANGE",
  "MULTIPLE_DRIVERS",
  "UNCONNECTED_PIN",
] as const;

export type ValidationIssueCode = (typeof VALIDATION_ISSUE_CODES)[number];

/**
 * One problem with a circuit. The location fields let a UI highlight the culprit and let
 * an API return the list unchanged.
 */
export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly message: string;
  /** The gate the issue is about, when it has a usable id. */
  readonly gateId?: string;
  /** Position in `circuit.gates`; set for gate-level issues, even when the gate has no usable id. */
  readonly gateIndex?: number;
  /** Position in `circuit.wires`; set for wire-level issues. */
  readonly wireIndex?: number;
  /** The input pin involved, for pin-level issues. */
  readonly pin?: number;
}

/** Problems a simulation can report about its `inputs`, and, in sequential mode, its `state`. */
export const INPUT_ISSUE_CODES = [
  "MALFORMED_INPUTS",
  "MISSING_INPUT",
  "UNKNOWN_INPUT",
  "INVALID_INPUT_VALUE",
  "MALFORMED_STATE",
  "UNKNOWN_STATE_GATE",
  "INVALID_STATE_VALUE",
] as const;

export type InputIssueCode = (typeof INPUT_ISSUE_CODES)[number];

export interface InputIssue {
  readonly code: InputIssueCode;
  readonly message: string;
  /** The input name involved (absent when the whole `inputs` value is malformed). */
  readonly inputId?: string;
  /** For a problem with the `state`: the gate id involved (absent when the whole `state` is malformed). */
  readonly stateGateId?: string;
}

/** Plain-data form of an error, as returned by `CircuitLabError.toJSON`. */
export interface ErrorData {
  readonly name: string;
  readonly message: string;
}

/** Base class for every error the engine throws on purpose, so callers can catch them all at once. */
export abstract class CircuitLabError extends Error {
  /**
   * The error as plain data. `JSON.stringify` calls this automatically, so an HTTP response,
   * a worker thread, and a job queue all see the same shape, and `reviveError` can turn it
   * back into a real error. (Without it, a thread boundary would reduce the error to a bare
   * `Error`, and JSON would drop even the message.)
   */
  abstract toJSON(): ErrorData;
}

/** The circuit's structure is invalid. `issues` lists every problem, not just the first. */
export class CircuitValidationError extends CircuitLabError {
  override readonly name = "CircuitValidationError";
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(summarize("Circuit is invalid", issues));
    this.issues = issues;
  }

  override toJSON(): ErrorData & { readonly issues: readonly ValidationIssue[] } {
    return { name: this.name, message: this.message, issues: this.issues };
  }
}

/** The gates form a feedback loop, so no evaluation order exists. */
export class CycleError extends CircuitLabError {
  override readonly name = "CycleError";
  /** Gate ids around the loop, closed: the first id is repeated at the end, e.g. `["q", "qbar", "q"]`. */
  readonly cycle: readonly string[];

  constructor(cycle: readonly string[]) {
    super(`Circuit contains a feedback loop: ${cycle.join(" -> ")}`);
    this.cycle = cycle;
  }

  override toJSON(): ErrorData & { readonly cycle: readonly string[] } {
    return { name: this.name, message: this.message, cycle: this.cycle };
  }
}

/** The `inputs` passed to `simulate` do not match the circuit's INPUT gates. */
export class SimulationInputError extends CircuitLabError {
  override readonly name = "SimulationInputError";
  readonly issues: readonly InputIssue[];

  constructor(issues: readonly InputIssue[]) {
    super(summarize("Invalid simulation inputs", issues));
    this.issues = issues;
  }

  override toJSON(): ErrorData & { readonly issues: readonly InputIssue[] } {
    return { name: this.name, message: this.message, issues: this.issues };
  }
}

/**
 * In sequential simulation: a feedback loop kept changing instead of settling. A ring of an odd
 * number of inverters does this, as real hardware would (it oscillates).
 */
export class OscillationError extends CircuitLabError {
  override readonly name = "OscillationError";
  /** The gates of the loop that kept changing, in declaration order. */
  readonly gates: readonly string[];

  constructor(gates: readonly string[]) {
    super(`Circuit does not settle: the loop of gates ${gates.join(", ")} keeps changing`);
    this.gates = gates;
  }

  override toJSON(): ErrorData & { readonly gates: readonly string[] } {
    return { name: this.name, message: this.message, gates: this.gates };
  }
}

/**
 * Rebuilds an engine error from its `toJSON()` data, e.g. after it crossed a worker thread or a
 * job queue. Returns `undefined` for anything else. The data's shape is checked, but it is meant
 * to come from your own services, not from end users.
 */
export function reviveError(data: unknown): CircuitLabError | undefined {
  if (!isRecord(data)) return undefined;
  switch (data.name) {
    case "CircuitValidationError":
      return isIssueList(data.issues, VALIDATION_ISSUE_CODES) ? new CircuitValidationError(data.issues) : undefined;
    case "CycleError":
      return Array.isArray(data.cycle) && data.cycle.every((id) => typeof id === "string") ? new CycleError(data.cycle) : undefined;
    case "SimulationInputError":
      return isIssueList(data.issues, INPUT_ISSUE_CODES) ? new SimulationInputError(data.issues) : undefined;
    case "OscillationError":
      return Array.isArray(data.gates) && data.gates.every((id) => typeof id === "string") ? new OscillationError(data.gates) : undefined;
    default:
      return undefined;
  }
}

function isIssueList<Code extends string>(value: unknown, codes: readonly Code[]): value is { code: Code; message: string }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (issue) =>
        isRecord(issue) && typeof issue.message === "string" && (codes as readonly unknown[]).includes(issue.code),
    )
  );
}

function summarize(title: string, issues: readonly { code: string; message: string }[]): string {
  const count = issues.length === 1 ? "1 issue" : `${issues.length} issues`;
  return [`${title} (${count}):`, ...issues.map((issue) => `  - [${issue.code}] ${issue.message}`)].join("\n");
}
