import { CircuitLabError, type ErrorData, type ValidationIssueCode } from "@circuitlab/engine";

/** Problems the netlist reader reports itself, with file positions. */
export const NETLIST_ISSUE_CODES = [
  "SYNTAX_ERROR",
  "LINE_TOO_LONG",
  "UNKNOWN_DIRECTIVE",
  "DUPLICATE_DIRECTIVE",
  "UNKNOWN_GATE_TYPE",
  "WRONG_INPUT_COUNT",
  "INVALID_CONST_VALUE",
  "DUPLICATE_GATE_ID",
  "UNDEFINED_SIGNAL",
  "OUTPUT_AS_SOURCE",
  "TOO_MANY_GATES",
  "TOO_MANY_ISSUES",
] as const;

export type NetlistIssueCode = (typeof NETLIST_ISSUE_CODES)[number];

export interface NetlistIssue {
  /**
   * A netlist code, or an engine validation code if the engine's final check caught something
   * the reader did not (which would be a bug in the reader).
   */
  readonly code: NetlistIssueCode | ValidationIssueCode;
  readonly message: string;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column, when the problem is at a specific spot on the line. */
  readonly column?: number;
}

/** The netlist text is not a valid circuit. `issues` lists every problem found, in file order. */
export class NetlistError extends CircuitLabError {
  override readonly name = "NetlistError";
  readonly issues: readonly NetlistIssue[];
  /** File name (or other label) used in messages, if one was given. */
  readonly source: string | undefined;

  constructor(issues: readonly NetlistIssue[], source?: string) {
    const count = issues.length === 1 ? "1 issue" : `${issues.length} issues`;
    const lines = issues.map((issue) => `  - ${formatLocation(source, issue)} [${issue.code}] ${issue.message}`);
    super([`Invalid netlist (${count}):`, ...lines].join("\n"));
    this.issues = issues;
    this.source = source;
  }

  override toJSON(): ErrorData & { readonly source: string | undefined; readonly issues: readonly NetlistIssue[] } {
    return { name: this.name, message: this.message, source: this.source, issues: this.issues };
  }
}

/** "adder.net:12:7", the location format compilers use, so editors can jump to it. */
function formatLocation(source: string | undefined, issue: NetlistIssue): string {
  const column = issue.column === undefined ? "" : `:${issue.column}`;
  return `${source ?? "netlist"}:${issue.line}${column}`;
}
