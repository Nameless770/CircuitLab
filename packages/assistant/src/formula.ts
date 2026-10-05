/**
 * The formulas the model writes, one for each output of a circuit: `A ^ B ^ CIN`,
 * `A + B + CIN >= 2`, `SEL ? D1 : D0`.
 *
 * Why formulas, when the model could write the gates? It was tried: a small model that writes gates
 * must also name every wire and connect them, and it gets that wrong most of the time. Writing
 * what a circuit computes is the part it is good at, and this file and `build.ts` do the rest
 * exactly (see docs/assistant.md for the numbers).
 *
 * The notation is a small part of what JavaScript and C accept, because that is what language
 * models know best. Every input is 0 or 1. The operators, from the loosest to the tightest:
 *
 *     a ? b : c      ||  or      &&  and      |      ^  xor      &      == !=      < <= > >=
 *     << >>          + -         * / %        ! ~ not -
 *
 * and the gates as functions, for people who think in gates: AND(A, B), NAND(A, B, C), NOT(A).
 */

export const GATE_FUNCTIONS = ["AND", "OR", "NAND", "NOR", "XOR", "XNOR", "NOT", "BUF"] as const;
export type GateFunction = (typeof GATE_FUNCTIONS)[number];

export type BinaryOperator = "||" | "&&" | "|" | "^" | "&" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "<<" | ">>" | "+" | "-" | "*" | "/" | "%";

export type Formula =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "name"; readonly name: string }
  | { readonly kind: "not"; readonly operand: Formula }
  | { readonly kind: "negate"; readonly operand: Formula }
  /** `parenthesized` is only used to refuse formulas whose order of evaluation is unclear. */
  | { readonly kind: "binary"; readonly operator: BinaryOperator; readonly left: Formula; readonly right: Formula; readonly parenthesized?: true }
  | { readonly kind: "choose"; readonly test: Formula; readonly then: Formula; readonly otherwise: Formula }
  | { readonly kind: "gate"; readonly gate: GateFunction; readonly inputs: readonly Formula[] };

/** A formula that can't be read or used. `message` is written for the person, and for the model. */
export class FormulaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormulaError";
  }
}

/** Words that mean an operator, so they can't be names of inputs. */
export const RESERVED_WORDS: readonly string[] = ["and", "or", "xor", "not", ...GATE_FUNCTIONS.map((gate) => gate.toLowerCase())];

/** From the loosest to the tightest. `?:` is handled before these, `!`, `~` and `-` after. */
const LEVELS: readonly (readonly BinaryOperator[])[] = [
  ["||"],
  ["&&"],
  ["|"],
  ["^"],
  ["&"],
  ["==", "!="],
  ["<", "<=", ">", ">="],
  ["<<", ">>"],
  ["+", "-"],
  ["*", "/", "%"],
];

const BITWISE: readonly BinaryOperator[] = ["|", "^", "&"];
const COMPARISONS: readonly BinaryOperator[] = ["==", "!=", "<", "<=", ">", ">="];
const WORD_OPERATORS: Readonly<Record<string, BinaryOperator>> = { and: "&&", or: "||", xor: "^" };

type Token =
  | { readonly type: "number"; readonly value: number }
  | { readonly type: "word"; readonly text: string }
  | { readonly type: "symbol"; readonly text: string }
  | { readonly type: "end" };

const SYMBOLS = ["<<", ">>", "<=", ">=", "==", "!=", "&&", "||", "?", ":", "|", "^", "&", "<", ">", "+", "-", "*", "/", "%", "!", "~", "(", ")", ","];

/**
 * Reads a formula.
 * @throws FormulaError saying what is wrong, in words that can be shown as they are
 */
export function parseFormula(text: string): Formula {
  const parser = new Parser(tokenize(text));
  const formula = parser.formula();
  refuseUnclearOrder(formula);
  return formula;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    if (/\s/.test(char)) {
      at++;
    } else if (/[0-9]/.test(char)) {
      const digits = /^[0-9]+/.exec(text.slice(at))?.[0] ?? char;
      if (/^[A-Za-z_]/.test(text.slice(at + digits.length))) throw new FormulaError(`“${digits}${text.charAt(at + digits.length)}…” isn't a number or a name; names start with a letter`);
      tokens.push({ type: "number", value: Number(digits) });
      at += digits.length;
    } else if (/[A-Za-z_]/.test(char)) {
      const word = /^[A-Za-z0-9_]+/.exec(text.slice(at))?.[0] ?? char;
      tokens.push({ type: "word", text: word });
      at += word.length;
    } else {
      const symbol = SYMBOLS.find((candidate) => text.startsWith(candidate, at));
      if (symbol === undefined) throw new FormulaError(`the character “${char}” can't be used in a formula`);
      tokens.push({ type: "symbol", text: symbol });
      at += symbol.length;
    }
  }
  tokens.push({ type: "end" });
  return tokens;
}

class Parser {
  private at = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  formula(): Formula {
    const result = this.choice();
    const next = this.peek();
    if (next.type !== "end") throw new FormulaError(`didn't expect ${describe(next)} here; the formula should have ended`);
    return result;
  }

  /** `test ? then : otherwise`, the loosest of all. Right to left: a ? b : c ? d : e. */
  private choice(): Formula {
    const test = this.level(0);
    if (!this.takeSymbol("?")) return test;
    const then = this.choice();
    if (!this.takeSymbol(":")) throw new FormulaError(`a “?” needs a “:” after its first choice, but found ${describe(this.peek())}`);
    return { kind: "choose", test, then, otherwise: this.choice() };
  }

  /** One level of binary operators, which group from left to right: a - b - c is (a - b) - c. */
  private level(index: number): Formula {
    const operators = LEVELS[index];
    if (operators === undefined) return this.unary();
    let left = this.level(index + 1);
    for (;;) {
      const operator = this.operatorAt(operators);
      if (operator === undefined) return left;
      left = { kind: "binary", operator, left, right: this.level(index + 1) };
    }
  }

  /** The operator coming next if it is one of `operators` (a symbol, or a word like "and"), and takes it. */
  private operatorAt(operators: readonly BinaryOperator[]): BinaryOperator | undefined {
    const next = this.peek();
    let operator: BinaryOperator | undefined;
    if (next.type === "symbol") operator = operators.find((candidate) => candidate === next.text);
    else if (next.type === "word") operator = WORD_OPERATORS[next.text.toLowerCase()];
    if (operator === undefined || !operators.includes(operator)) return undefined;
    this.at++;
    return operator;
  }

  private unary(): Formula {
    const next = this.peek();
    if (next.type === "symbol" && (next.text === "!" || next.text === "~")) {
      this.at++;
      return { kind: "not", operand: this.unary() };
    }
    if (next.type === "symbol" && next.text === "-") {
      this.at++;
      return { kind: "negate", operand: this.unary() };
    }
    // "not A" and "NOT(A)" both mean the same thing; the second is also a gate with one input.
    if (next.type === "word" && next.text.toLowerCase() === "not" && !this.isCallAfter()) {
      this.at++;
      return { kind: "not", operand: this.unary() };
    }
    return this.primary();
  }

  private primary(): Formula {
    const next = this.peek();
    this.at++;
    if (next.type === "number") return { kind: "number", value: next.value };
    if (next.type === "word") {
      const gate = GATE_FUNCTIONS.find((candidate) => candidate === next.text.toUpperCase());
      if (gate !== undefined && this.peekSymbol("(")) return this.call(gate);
      if (RESERVED_WORDS.includes(next.text.toLowerCase())) throw new FormulaError(`“${next.text}” is an operator, but it has nothing to work on here`);
      return { kind: "name", name: next.text };
    }
    if (next.type === "symbol" && next.text === "(") {
      const inside = this.choice();
      if (!this.takeSymbol(")")) throw new FormulaError(`a “(” needs a “)” to close it, but found ${describe(this.peek())}`);
      return inside.kind === "binary" ? { ...inside, parenthesized: true } : inside;
    }
    this.at--; // the token that doesn't belong stays where it is, to be described
    throw new FormulaError(`expected a name, a number or “(”, but found ${describe(next)}`);
  }

  /** AND(a, b, c): the name and the “(” are next. */
  private call(gate: GateFunction): Formula {
    this.takeSymbol("(");
    const inputs: Formula[] = [];
    if (!this.takeSymbol(")")) {
      do inputs.push(this.choice());
      while (this.takeSymbol(","));
      if (!this.takeSymbol(")")) throw new FormulaError(`${gate}( needs a “)” to close it, but found ${describe(this.peek())}`);
    }
    return { kind: "gate", gate, inputs };
  }

  private isCallAfter(): boolean {
    const after = this.tokens[this.at + 1];
    return after?.type === "symbol" && after.text === "(";
  }

  private peek(): Token {
    return this.tokens[this.at] ?? { type: "end" };
  }

  private peekSymbol(text: string): boolean {
    const next = this.peek();
    return next.type === "symbol" && next.text === text;
  }

  private takeSymbol(text: string): boolean {
    if (!this.peekSymbol(text)) return false;
    this.at++;
    return true;
  }
}

function describe(token: Token): string {
  if (token.type === "end") return "the end of the formula";
  if (token.type === "number") return `the number ${token.value}`;
  return `“${token.text}”`;
}

/**
 * JavaScript and C put comparisons *above* & | ^, Python puts them below, so `A & B == C` means
 * different things to different readers (and to the model). Refusing it makes whoever wrote it add
 * the parentheses, instead of guessing.
 */
function refuseUnclearOrder(formula: Formula): void {
  switch (formula.kind) {
    case "binary": {
      const mixes = (outer: readonly BinaryOperator[], inner: readonly BinaryOperator[]): boolean =>
        outer.includes(formula.operator) && [formula.left, formula.right].some((side) => side.kind === "binary" && inner.includes(side.operator) && side.parenthesized !== true);
      if (mixes(BITWISE, COMPARISONS) || mixes(COMPARISONS, BITWISE)) {
        throw new FormulaError(`it isn't clear what comes first around “${formula.operator}”: put parentheses around the comparison, or around the & | ^ part`);
      }
      refuseUnclearOrder(formula.left);
      refuseUnclearOrder(formula.right);
      return;
    }
    case "not":
    case "negate":
      refuseUnclearOrder(formula.operand);
      return;
    case "choose":
      refuseUnclearOrder(formula.test);
      refuseUnclearOrder(formula.then);
      refuseUnclearOrder(formula.otherwise);
      return;
    case "gate":
      formula.inputs.forEach(refuseUnclearOrder);
      return;
    default:
      return;
  }
}

/** A formula written out again, for messages. Parentheses wherever there's a doubt. */
export function printFormula(formula: Formula): string {
  const wrap = (node: Formula): string => (node.kind === "binary" || node.kind === "choose" ? `(${printFormula(node)})` : printFormula(node));
  switch (formula.kind) {
    case "number":
      return String(formula.value);
    case "name":
      return formula.name;
    case "not":
      return `!${wrap(formula.operand)}`;
    case "negate":
      return `-${wrap(formula.operand)}`;
    case "binary":
      return `${wrap(formula.left)} ${formula.operator} ${wrap(formula.right)}`;
    case "choose":
      return `${wrap(formula.test)} ? ${wrap(formula.then)} : ${wrap(formula.otherwise)}`;
    case "gate":
      return `${formula.gate}(${formula.inputs.map(printFormula).join(", ")})`;
  }
}

/** Every name the formula uses, once each, in the order they first appear. */
export function namesIn(formula: Formula): string[] {
  const found = new Set<string>();
  const visit = (node: Formula): void => {
    switch (node.kind) {
      case "name":
        found.add(node.name);
        return;
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
      case "gate":
        node.inputs.forEach(visit);
        return;
      case "number":
        return;
    }
  };
  visit(formula);
  return [...found];
}

/**
 * The value of a formula, given the value of each name. Whole numbers all the way, like the
 * formulas are meant to be read: 1 is true, anything else that isn't 0 also counts as true inside
 * && || ! and the gates.
 * @throws FormulaError for a division by zero
 */
export function evaluateFormula(formula: Formula, valueOf: (name: string) => number): number {
  const evaluate = (node: Formula): number => {
    switch (node.kind) {
      case "number":
        return node.value;
      case "name":
        return valueOf(node.name);
      case "not":
        return evaluate(node.operand) === 0 ? 1 : 0;
      case "negate":
        return -evaluate(node.operand);
      case "choose":
        return evaluate(node.test) !== 0 ? evaluate(node.then) : evaluate(node.otherwise);
      case "binary":
        return applyOperator(node.operator, evaluate(node.left), evaluate(node.right));
      case "gate":
        return applyGate(node.gate, node.inputs.map((input) => (evaluate(input) !== 0 ? 1 : 0)));
    }
  };
  return evaluate(formula);
}

function applyOperator(operator: BinaryOperator, left: number, right: number): number {
  switch (operator) {
    case "||":
      return left !== 0 || right !== 0 ? 1 : 0;
    case "&&":
      return left !== 0 && right !== 0 ? 1 : 0;
    case "|":
      return left | right;
    case "^":
      return left ^ right;
    case "&":
      return left & right;
    case "==":
      return left === right ? 1 : 0;
    case "!=":
      return left !== right ? 1 : 0;
    case "<":
      return left < right ? 1 : 0;
    case "<=":
      return left <= right ? 1 : 0;
    case ">":
      return left > right ? 1 : 0;
    case ">=":
      return left >= right ? 1 : 0;
    case "<<":
      return left * 2 ** Math.min(Math.max(right, 0), 30);
    case ">>":
      return Math.floor(left / 2 ** Math.min(Math.max(right, 0), 30));
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      if (right === 0) throw new FormulaError("it divides by zero");
      return Math.trunc(left / right);
    case "%":
      if (right === 0) throw new FormulaError("it divides by zero");
      return left % right;
  }
}

/** What a gate does to inputs that are already 0 or 1. NOT and BUF are only given one input. */
export function applyGate(gate: GateFunction, inputs: readonly number[]): number {
  const ones = inputs.filter((value) => value === 1).length;
  switch (gate) {
    case "AND":
      return ones === inputs.length ? 1 : 0;
    case "OR":
      return ones > 0 ? 1 : 0;
    case "NAND":
      return ones === inputs.length ? 0 : 1;
    case "NOR":
      return ones > 0 ? 0 : 1;
    case "XOR":
      return ones % 2;
    case "XNOR":
      return 1 - (ones % 2);
    case "NOT":
      return inputs[0] === 1 ? 0 : 1;
    case "BUF":
      return inputs[0] === 1 ? 1 : 0;
  }
}
