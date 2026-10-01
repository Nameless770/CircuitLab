// The netlist parser. Pure TypeScript with no Node imports: it is fed one line at a time, so
// the same code serves in-memory strings (parseNetlist) and streams (importNetlist).

import {
  GATE_ARITY,
  GATE_TYPES,
  isGateType,
  validateCircuit,
  type Circuit,
  type Gate,
  type GateType,
  type ValidationIssue,
  type Wire,
} from "@circuitlab/engine";
import { NetlistError, type NetlistIssue, type NetlistIssueCode } from "./errors";

/** A valid gate name. It can't start with "." because that starts a directive. */
export const IDENTIFIER = /^[A-Za-z0-9_][A-Za-z0-9_.$[\]]*$/;
const IDENTIFIER_CHAR = /[A-Za-z0-9_.$[\]]/;

/** Spellings accepted besides the engine's own type names. BUFF is the ISCAS benchmark spelling. */
const TYPE_ALIASES: Readonly<Record<string, GateType>> = { BUFF: "BUF" };

export interface NetlistOptions {
  /** Name shown in error locations, typically the file name. */
  readonly source?: string;
  /** Longest line accepted, in characters. Stops a file without line breaks from filling memory. Default 16,384. */
  readonly maxLineLength?: number;
  /** Most gates accepted; reading stops as soon as the file has more. Default 1,000,000. */
  readonly maxGates?: number;
  /** Reading stops after this many problems. Default 100. */
  readonly maxIssues?: number;
}

export const DEFAULT_MAX_LINE_LENGTH = 16_384;

/**
 * Parses netlist text that is already in memory. For files and uploads use `importNetlist`,
 * which streams.
 *
 * @throws NetlistError listing every problem, with line and column
 */
export function parseNetlist(text: string, options: NetlistOptions = {}): Circuit {
  const parser = new NetlistParser(options);
  const lines = text.replace(/^﻿/, "").split("\n");
  lines.forEach((line, index) => parser.feedLine(line.endsWith("\r") ? line.slice(0, -1) : line, index + 1));
  return parser.finish();
}

export function lineTooLongIssue(line: number, maxLineLength: number): NetlistIssue {
  return { code: "LINE_TOO_LONG", message: `line is longer than ${maxLineLength} characters`, line };
}

interface Token {
  readonly text: string;
  readonly column: number;
}

/** A wire plus where its source was named, so errors about it can point at that spot. */
interface Link {
  readonly wire: Wire;
  readonly line: number;
  readonly column: number;
}

/**
 * Builds a circuit from netlist lines fed in order. Names may be used before the line that
 * defines them, so references are resolved in `finish()`.
 *
 * The rules (gate types, input counts) come from the engine; this class only phrases problems in
 * terms of the file. The engine's own validator still runs at the end and has the final word.
 */
export class NetlistParser {
  private readonly source: string | undefined;
  private readonly maxLineLength: number;
  private readonly maxGates: number;
  private readonly maxIssues: number;

  private name: { readonly value: string; readonly line: number } | undefined;
  private readonly gates: Gate[] = [];
  private readonly gateLines: number[] = [];
  private readonly links: Link[] = [];
  /** Every name defined so far, even on lines that had errors, so later uses don't cascade into more errors. */
  private readonly defined = new Map<string, { readonly line: number; readonly type: GateType | undefined }>();
  private readonly issues: NetlistIssue[] = [];
  private finished = false;

  constructor(options: NetlistOptions = {}) {
    this.source = options.source;
    this.maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
    this.maxGates = options.maxGates ?? 1_000_000;
    this.maxIssues = options.maxIssues ?? 100;
  }

  /** Reads one line, without its line break. `line` is the 1-based line number. */
  feedLine(text: string, line: number): void {
    if (this.finished) throw new Error("NetlistParser: feedLine() called after finish()");
    if (text.length > this.maxLineLength) this.stop(lineTooLongIssue(line, this.maxLineLength));
    try {
      this.readStatement(new LineScanner(text), line);
    } catch (error) {
      if (!(error instanceof SyntaxProblem)) throw error;
      this.report("SYNTAX_ERROR", error.message, line, error.column);
    }
  }

  /**
   * Checks the names used before they were defined, then returns the circuit.
   * @throws NetlistError listing every problem in the file, in file order
   */
  finish(): Circuit {
    if (this.finished) throw new Error("NetlistParser: finish() called twice");
    this.finished = true;

    for (const { wire, line, column } of this.links) {
      const source = this.defined.get(wire.from);
      if (source === undefined) {
        this.report("UNDEFINED_SIGNAL", `${quote(wire.from)} is not defined`, line, column);
      } else if (source.type === "OUTPUT") {
        this.report("OUTPUT_AS_SOURCE", `${quote(wire.from)} is an OUTPUT; outputs cannot drive other gates`, line, column);
      }
    }
    if (this.issues.length > 0) throw new NetlistError(byPosition(this.issues), this.source);

    const circuit: Circuit = {
      ...(this.name && { name: this.name.value }),
      gates: this.gates,
      wires: this.links.map((link) => link.wire),
    };
    // The engine has the final word. The checks above should cover everything it looks at;
    // if they ever miss something, it is still reported at the right line.
    const missed = validateCircuit(circuit);
    if (missed.length > 0) throw new NetlistError(missed.map((issue) => this.locate(issue)), this.source);
    return circuit;
  }

  private readStatement(scanner: LineScanner, line: number): void {
    if (scanner.atEnd()) return; // blank line or comment
    if (scanner.peek() === ".") return this.readDirective(scanner, line);

    // name = TYPE(input, input, ...) "optional label"
    const id = scanner.identifier("a gate name");
    scanner.expect("=", `"=" after ${quote(id.text)}`);
    const type = scanner.identifier("a gate type such as AND");
    const args: Token[] = [];
    if (scanner.accept("(") && !scanner.accept(")")) {
      do args.push(scanner.identifier("an input name")); while (scanner.accept(","));
      scanner.expect(")", `"," or ")"`);
    }
    const label = scanner.peek() === '"' ? scanner.string() : undefined;
    scanner.expectEnd();
    this.defineGate(line, id, type, args, label);
  }

  private readDirective(scanner: LineScanner, line: number): void {
    const column = scanner.column();
    scanner.expect(".", `"."`);
    const directive = scanner.identifier("a directive name after \".\"");
    if (directive.text !== "name") {
      return this.report("UNKNOWN_DIRECTIVE", `unknown directive ".${directive.text}" (the only one is .name)`, line, column);
    }
    const value = scanner.string();
    scanner.expectEnd();
    if (this.name !== undefined) {
      return this.report("DUPLICATE_DIRECTIVE", `.name was already set on line ${this.name.line}`, line, column);
    }
    this.name = { value, line };
  }

  private defineGate(line: number, id: Token, typeToken: Token, args: readonly Token[], label: string | undefined): void {
    const earlier = this.defined.get(id.text);
    if (earlier !== undefined) {
      return this.report("DUPLICATE_GATE_ID", `${quote(id.text)} is already defined on line ${earlier.line}`, line, id.column);
    }
    const typeName = typeToken.text.toUpperCase();
    const type = TYPE_ALIASES[typeName] ?? (isGateType(typeName) ? typeName : undefined);
    this.defined.set(id.text, { line, type });

    if (type === undefined) {
      const expected = GATE_TYPES.join(", ");
      return this.report("UNKNOWN_GATE_TYPE", `unknown gate type ${quote(typeToken.text)} (expected one of ${expected})`, line, typeToken.column);
    }
    const labelField = label === undefined ? {} : { label };

    if (type === "CONST") {
      const value = args.length === 1 ? args[0]?.text : undefined;
      if (value !== "0" && value !== "1") {
        const column = (args[0] ?? typeToken).column;
        return this.report("INVALID_CONST_VALUE", `CONST needs exactly one value, 0 or 1, as in ${id.text} = CONST(1)`, line, column);
      }
      return this.addGate({ id: id.text, type, value: value === "1" ? 1 : 0, ...labelField }, line);
    }

    const { min, max } = GATE_ARITY[type];
    if (args.length < min || args.length > max) {
      return this.report("WRONG_INPUT_COUNT", `${type} ${describeArity(min, max)}, got ${args.length}`, line, typeToken.column);
    }
    this.addGate({ id: id.text, type, ...labelField }, line);
    // Inputs are listed in pin order, so pin numbers are implied: no gaps, no pin driven twice.
    args.forEach((arg, pin) => this.links.push({ wire: { from: arg.text, to: id.text, toPin: pin }, line, column: arg.column }));
  }

  private addGate(gate: Gate, line: number): void {
    if (this.gates.length >= this.maxGates) {
      this.stop({ code: "TOO_MANY_GATES", message: `more than ${this.maxGates} gates; reading stopped`, line });
    }
    this.gates.push(gate);
    this.gateLines.push(line);
  }

  private report(code: NetlistIssueCode, message: string, line: number, column?: number): void {
    this.issues.push(column === undefined ? { code, message, line } : { code, message, line, column });
    if (this.issues.length >= this.maxIssues) {
      this.stop({ code: "TOO_MANY_ISSUES", message: `stopped after ${this.maxIssues} problems`, line });
    }
  }

  /**
   * Gives up immediately; thrown from inside a stream, this also stops reading the file.
   * `reason` goes last, after the problems found so far, since it explains why the list ends.
   */
  private stop(reason: NetlistIssue): never {
    throw new NetlistError([...byPosition(this.issues), reason], this.source);
  }

  private locate(issue: ValidationIssue): NetlistIssue {
    const link = issue.wireIndex === undefined ? undefined : this.links[issue.wireIndex];
    if (link !== undefined) return { code: issue.code, message: issue.message, line: link.line, column: link.column };
    const line = issue.gateIndex === undefined ? undefined : this.gateLines[issue.gateIndex];
    return { code: issue.code, message: issue.message, line: line ?? 1 };
  }
}

/** Signals a syntax error at a column; caught by feedLine and turned into an issue. */
class SyntaxProblem {
  constructor(
    readonly message: string,
    readonly column: number,
  ) {}
}

/** Reads one line left to right. Every read skips spaces and tabs first. */
class LineScanner {
  private position = 0;

  constructor(private readonly text: string) {}

  /** 1-based column of the next character to read. */
  column(): number {
    this.skipSpaces();
    return this.position + 1;
  }

  /** True when only spaces or a comment remain. */
  atEnd(): boolean {
    this.skipSpaces();
    return this.position >= this.text.length || this.text.charAt(this.position) === "#";
  }

  peek(): string {
    this.skipSpaces();
    return this.text.charAt(this.position);
  }

  accept(char: string): boolean {
    if (this.peek() !== char) return false;
    this.position++;
    return true;
  }

  expect(char: string, description: string): void {
    if (!this.accept(char)) this.fail(`expected ${description}`);
  }

  identifier(description: string): Token {
    const column = this.column();
    const start = this.position;
    while (IDENTIFIER_CHAR.test(this.text.charAt(this.position))) this.position++;
    const text = this.text.slice(start, this.position);
    if (!IDENTIFIER.test(text)) {
      this.position = start;
      this.fail(`expected ${description}`);
    }
    return { text, column };
  }

  /** A double-quoted string. Escapes follow JSON rules, e.g. "say \"hi\"". */
  string(): string {
    const column = this.column();
    if (this.text.charAt(this.position) !== '"') this.fail("expected a quoted string");
    let end = this.position + 1;
    while (end < this.text.length && this.text.charAt(end) !== '"') end += this.text.charAt(end) === "\\" ? 2 : 1;
    if (end >= this.text.length) throw new SyntaxProblem("unterminated string: the closing quote is missing", column);
    const literal = this.text.slice(this.position, end + 1);
    this.position = end + 1;
    try {
      return JSON.parse(literal) as string;
    } catch {
      throw new SyntaxProblem(`invalid string ${shorten(literal)}: only JSON-style escapes such as \\" and \\t are allowed`, column);
    }
  }

  expectEnd(): void {
    if (!this.atEnd()) this.fail("expected the end of the line");
  }

  /** Throws "expected X, but found Y" pointing at the current column. */
  private fail(expected: string): never {
    const nextWord = /^\S+/.exec(this.text.slice(this.position))?.[0] ?? "";
    const found = this.atEnd() ? "the line ended" : `found ${shorten(nextWord)}`;
    throw new SyntaxProblem(`${expected}, but ${found}`, this.column());
  }

  private skipSpaces(): void {
    while (this.text.charAt(this.position) === " " || this.text.charAt(this.position) === "\t") this.position++;
  }
}

function describeArity(min: number, max: number): string {
  if (max === 0) return "takes no inputs";
  if (min === max) return `needs exactly ${min} input${min === 1 ? "" : "s"}`;
  return `needs ${min} to ${max} inputs`;
}

function byPosition(issues: readonly NetlistIssue[]): NetlistIssue[] {
  return [...issues].sort((a, b) => a.line - b.line || (a.column ?? 0) - (b.column ?? 0));
}

function quote(name: string): string {
  return JSON.stringify(name.length > 40 ? `${name.slice(0, 40)}...` : name);
}

function shorten(text: string): string {
  return JSON.stringify(text.length > 30 ? `${text.slice(0, 30)}...` : text);
}
