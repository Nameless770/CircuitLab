import type { Circuit } from "@circuitlab/engine";
import { NetlistError, parseNetlist } from "@circuitlab/netlist";
import { FormulaError, RESERVED_WORDS, evaluateFormula, namesIn, parseFormula, printFormula, type Formula } from "./formula";
import { minimize, type Term } from "./minimize";

/**
 * Builds a circuit from what the model wrote: names, and a formula for each output. The model
 * doesn't choose gates or wire anything, so there is nothing it can wire wrongly; the netlist
 * comes out of here exactly, and goes through the real netlist reader once more before anyone
 * sees it.
 */

export interface Definition {
  readonly name: string;
  readonly formula: string;
}

export interface CircuitSpec {
  readonly name: string;
  readonly inputs: readonly string[];
  /**
   * Named values that formulas can use. Most circuits have none. They are for a value used twice,
   * and for feedback: signals can use each other in a loop, which is what a latch is.
   */
  readonly signals: readonly Definition[];
  /** Each result of the circuit, and a formula for it. */
  readonly outputs: readonly Definition[];
}

export type BuildResult =
  | { readonly ok: true; readonly netlist: string; readonly circuit: Circuit }
  /** Every problem found, each a sentence that can be shown to the person, or sent back to the model. */
  | { readonly ok: false; readonly problems: readonly string[] };

/** Most inputs a circuit may have. */
export const MAX_INPUTS = 16;
/**
 * Most inputs one arithmetic or comparison formula may depend on. Its truth table has 2 to that
 * power rows, and the gates for it grow quickly with it.
 */
export const MAX_TABLE_INPUTS = 8;
/** The netlist format allows no more inputs on one gate. */
const MAX_GATE_INPUTS = 64;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A problem with one formula, found while its gates were being built. */
class BuildProblem extends Error {}

export function buildCircuit(spec: CircuitSpec): BuildResult {
  const problems: string[] = [];

  // Names: every input, signal and output has its own.
  const kinds = new Map<string, "input" | "signal" | "output">();
  const declare = (name: string, kind: "input" | "signal" | "output"): void => {
    if (!NAME.test(name)) problems.push(`“${name}” can't be used as the name of ${article(kind)} ${kind}: names start with a letter and have only letters, digits and _.`);
    else if (RESERVED_WORDS.includes(name.toLowerCase())) problems.push(`“${name}” can't be the name of ${article(kind)} ${kind}: in formulas it means an operator. Pick another name.`);
    else if (kinds.has(name)) problems.push(`The name “${name}” is used twice (as ${article(kinds.get(name) ?? kind)} ${kinds.get(name)} and as ${article(kind)} ${kind}). Every input, signal and output needs its own name.`);
    else kinds.set(name, kind);
  };
  spec.inputs.forEach((name) => declare(name, "input"));
  spec.signals.forEach((definition) => declare(definition.name, "signal"));
  spec.outputs.forEach((definition) => declare(definition.name, "output"));
  if (spec.inputs.length === 0) problems.push("The circuit has no inputs.");
  if (spec.inputs.length > MAX_INPUTS) problems.push(`The circuit has ${spec.inputs.length} inputs; the most the assistant builds is ${MAX_INPUTS}.`);
  if (spec.outputs.length === 0) problems.push("The circuit has no outputs: every result needs an entry in the list of outputs, with a formula.");

  // Formulas: read, then every name in them must exist.
  const formulas = new Map<string, Formula>();
  for (const definition of [...spec.signals, ...spec.outputs]) {
    try {
      const formula = parseFormula(definition.formula);
      problems.push(...checkNames(definition.name, formula, kinds));
      formulas.set(definition.name, formula);
    } catch (error) {
      if (!(error instanceof FormulaError)) throw error;
      problems.push(`The formula for “${definition.name}” can't be read: ${error.message}. The formula was: ${definition.formula}`);
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  // Gates.
  const builder = new Builder(new Set(spec.inputs), kinds.keys());
  const outputLines: string[] = [];
  for (const [owner, wanted] of [...spec.signals.map((signal) => [signal, signal.name] as const), ...spec.outputs.map((output) => [output, undefined] as const)]) {
    const formula = formulas.get(owner.name);
    if (formula === undefined) continue; // can't happen: a formula that couldn't be read ended the function above
    try {
      const driver = builder.emit(formula, owner.name, wanted);
      if (wanted === undefined) outputLines.push(`${owner.name} = OUTPUT(${driver})`);
    } catch (error) {
      if (!(error instanceof BuildProblem || error instanceof FormulaError)) throw error;
      problems.push(error instanceof FormulaError ? `The formula for “${owner.name}” can't be worked out: ${error.message}.` : error.message);
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const title = spec.name.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 60) || "Circuit";
  const netlist = [`.name ${JSON.stringify(title)}`, ...spec.inputs.map((name) => `${name} = INPUT`), ...builder.lines, ...outputLines].join("\n") + "\n";
  try {
    return { ok: true, netlist, circuit: parseNetlist(netlist) };
  } catch (error) {
    if (!(error instanceof NetlistError)) throw error;
    // Not expected: the checks above should have caught everything. Told like any other problem.
    return { ok: false, problems: error.issues.map((issue) => `The circuit that was built isn't valid (line ${issue.line}): ${issue.message}`) };
  }
}

const article = (word: string): string => (/^[aeiou]/.test(word) ? "an" : "a");

/** The names in one formula must be inputs or signals; the gates must have a sensible number of inputs. */
function checkNames(owner: string, formula: Formula, kinds: ReadonlyMap<string, "input" | "signal" | "output">): string[] {
  const problems: string[] = [];
  for (const name of namesIn(formula)) {
    const kind = kinds.get(name);
    if (kind === undefined) problems.push(`The formula for “${owner}” uses “${name}”, but there is no input or signal with that name.`);
    else if (kind === "output") problems.push(`The formula for “${owner}” uses “${name}”, which is an output. Outputs can't be used inside formulas; use an input or a signal.`);
  }
  const visit = (node: Formula): void => {
    switch (node.kind) {
      case "gate": {
        const single = node.gate === "NOT" || node.gate === "BUF";
        if (single ? node.inputs.length !== 1 : node.inputs.length < 2) {
          problems.push(`${node.gate} needs ${single ? "exactly one input" : "at least two inputs"}, but ${printFormula(node)} in the formula for “${owner}” has ${node.inputs.length}.`);
        }
        node.inputs.forEach(visit);
        return;
      }
      case "binary":
        visit(node.left);
        visit(node.right);
        return;
      case "not":
      case "negate":
        visit(node.operand);
        return;
      case "choose":
        visit(node.test);
        visit(node.then);
        visit(node.otherwise);
        return;
      default:
        return;
    }
  };
  visit(formula);
  return problems;
}

/** Operators that are an AND, OR or XOR of 0-or-1 values. */
const FAMILY: Readonly<Record<string, "AND" | "OR" | "XOR">> = { "&": "AND", "&&": "AND", "|": "OR", "||": "OR", "^": "XOR" };

/**
 * A formula is "boolean" when its own operator is one that gates do: names, 0 and 1, ! & | ^ and
 * the gate functions. Those become gates one for one. Everything else (arithmetic, comparisons,
 * ?: ) says what is computed but not how, so it is turned into a truth table and then into gates.
 * What is inside a boolean operator can be either.
 */
function isBoolean(formula: Formula): boolean {
  switch (formula.kind) {
    case "name":
    case "not":
    case "gate":
      return true;
    case "number":
      return formula.value === 0 || formula.value === 1;
    case "binary":
      return FAMILY[formula.operator] !== undefined;
    default:
      return false;
  }
}

/** `a & b & c` is ((a & b) & c); gates take any number of inputs, so it is one AND with three. */
function operandsOf(formula: Formula, family: string): Formula[] {
  if (formula.kind === "binary" && FAMILY[formula.operator] === family) return [...operandsOf(formula.left, family), ...operandsOf(formula.right, family)];
  return [formula];
}

class Builder {
  /** The gates, in the order they were made. */
  readonly lines: string[] = [];
  private readonly made = new Map<string, string>();
  private readonly counts = new Map<string, number>();
  private readonly taken: Set<string>;

  constructor(
    private readonly inputs: ReadonlySet<string>,
    names: Iterable<string>,
  ) {
    this.taken = new Set(names);
  }

  /**
   * Makes the gates for a formula, and returns the name of the one that carries its result.
   * `wanted` is a name that gate must have (the name of a signal); without it, a gate is named
   * after its type, and an identical gate made before is reused.
   */
  emit(formula: Formula, owner: string, wanted?: string): string {
    if (!isBoolean(formula)) return this.table(formula, owner, wanted);
    switch (formula.kind) {
      case "name":
        return wanted === undefined ? formula.name : this.gate("BUF", [formula.name], wanted);
      case "number":
        return this.gate("CONST", [String(formula.value)], wanted, formula.value === 1 ? "one" : "zero");
      case "not":
        return this.gate("NOT", [this.emit(formula.operand, owner)], wanted);
      case "gate":
        return this.gate(formula.gate, formula.inputs.map((input) => this.emit(input, owner)), wanted);
      case "binary": {
        const family = FAMILY[formula.operator] ?? "AND";
        return this.gate(family, operandsOf(formula, family).map((operand) => this.emit(operand, owner)), wanted);
      }
      default:
        throw new Error(`Builder.emit: ${formula.kind} is not a boolean formula`); // isBoolean() sent it to table() instead
    }
  }

  private gate(type: string, inputs: readonly string[], wanted?: string, base: string = type.toLowerCase()): string {
    const key = `${type}(${inputs.join(",")})`;
    if (wanted === undefined) {
      const earlier = this.made.get(key);
      if (earlier !== undefined) return earlier;
    }
    const name = wanted ?? this.fresh(base);
    this.lines.push(`${name} = ${type}(${inputs.join(", ")})`);
    if (wanted === undefined) this.made.set(key, name);
    return name;
  }

  private fresh(base: string): string {
    let name: string;
    do {
      const count = (this.counts.get(base) ?? 0) + 1;
      this.counts.set(base, count);
      name = `${base}${count}`;
    } while (this.taken.has(name));
    this.taken.add(name);
    return name;
  }

  /** `driver` under the name `wanted`, when a name is wanted. */
  private named(driver: string, wanted: string | undefined): string {
    return wanted === undefined ? driver : this.gate("BUF", [driver], wanted);
  }

  /** The truth table of a formula that only depends on inputs, and gates that give the same table. */
  private table(formula: Formula, owner: string, wanted: string | undefined): string {
    const names = namesIn(formula);
    const signal = names.find((name) => !this.inputs.has(name));
    if (signal !== undefined) {
      throw new BuildProblem(
        `The formula for “${owner}” uses the signal “${signal}” inside ${printFormula(formula)}. Arithmetic, comparisons and ? : work on inputs only; on signals use & | ^ !.`,
      );
    }
    if (names.length > MAX_TABLE_INPUTS) {
      throw new BuildProblem(
        `The part ${printFormula(formula)} of the formula for “${owner}” depends on ${names.length} inputs; the assistant can work out at most ${MAX_TABLE_INPUTS} at a time. Split it into smaller parts with & | ^ !.`,
      );
    }
    const position = new Map(names.map((name, index) => [name, index]));
    const bitOf = (row: number, index: number): number => (row >> (names.length - 1 - index)) & 1;
    const column: number[] = [];
    for (let row = 0; row < 2 ** names.length; row++) {
      const result = evaluateFormula(formula, (name) => bitOf(row, position.get(name) ?? 0));
      if (result !== 0 && result !== 1) {
        const when = names.length === 0 ? "always" : `when ${names.map((name, index) => `${name}=${bitOf(row, index)}`).join(" ")}`;
        throw new BuildProblem(
          `The part ${printFormula(formula)} of the formula for “${owner}” gives ${result} ${when}, but only 0 and 1 are allowed. To count something, compare it: write A + B >= 1 instead of A + B.`,
        );
      }
      column.push(result);
    }
    return this.fromTable(names, column, wanted, bitOf);
  }

  /** The smallest gates the table allows: a constant, one input, a parity, or a sum of products. */
  private fromTable(names: readonly string[], column: readonly number[], wanted: string | undefined, bitOf: (row: number, index: number) => number): string {
    const ones = column.filter((value) => value === 1).length;
    if (ones === 0 || ones === column.length) return this.gate("CONST", [ones === 0 ? "0" : "1"], wanted, ones === 0 ? "zero" : "one");

    for (const [index, name] of names.entries()) {
      if (column.every((value, row) => value === bitOf(row, index))) return this.named(name, wanted);
      if (column.every((value, row) => value === 1 - bitOf(row, index))) return this.gate("NOT", [name], wanted);
    }
    // XOR of all the inputs (or its opposite) is the one table that sums of products make huge.
    const parity = column.map((_, row) => names.reduce((total, _name, index) => total + bitOf(row, index), 0) % 2);
    if (names.length >= 2 && column.every((value, row) => value === parity[row])) return this.gate("XOR", names, wanted);
    if (names.length >= 2 && column.every((value, row) => value === 1 - (parity[row] ?? 0))) return this.gate("XNOR", names, wanted);

    const terms = minimize(column, names.length);
    if (terms.length === 1) return this.product(names, terms[0] as Term, wanted);
    return this.gate("OR", this.limited(terms.map((term) => this.product(names, term, undefined))), wanted);
  }

  /** The AND of the inputs a term says matter, each inverted where the term says 0. */
  private product(names: readonly string[], term: Term, wanted: string | undefined): string {
    const literals = names.flatMap((name, index) => (term[index] === 1 ? [name] : term[index] === 0 ? [this.gate("NOT", [name])] : []));
    return literals.length === 1 ? this.named(literals[0] as string, wanted) : this.gate("AND", literals, wanted);
  }

  /** A gate takes at most 64 inputs; a bigger OR is built as an OR of ORs. */
  private limited(inputs: string[]): string[] {
    let current = inputs;
    while (current.length > MAX_GATE_INPUTS) {
      const next: string[] = [];
      for (let start = 0; start < current.length; start += MAX_GATE_INPUTS) {
        const chunk = current.slice(start, start + MAX_GATE_INPUTS);
        next.push(chunk.length === 1 ? (chunk[0] as string) : this.gate("OR", chunk));
      }
      current = next;
    }
    return current;
  }
}
