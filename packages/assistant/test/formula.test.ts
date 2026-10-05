import { describe, expect, it } from "vitest";
import { FormulaError, evaluateFormula, namesIn, parseFormula, printFormula } from "@circuitlab/assistant";

/** The value of a formula for the given inputs. */
function run(text: string, values: Record<string, number> = {}): number {
  return evaluateFormula(parseFormula(text), (name) => {
    const value = values[name];
    if (value === undefined) throw new Error(`no value for ${name}`);
    return value;
  });
}

describe("parseFormula: what formulas mean", () => {
  it("follows the usual order: * before +, + before comparisons, comparisons before &&", () => {
    expect(run("2 + 3 * 4")).toBe(14);
    expect(run("(2 + 3) * 4")).toBe(20);
    expect(run("1 + 1 == 2 && 3 > 2")).toBe(1);
    expect(run("10 - 3 - 2")).toBe(5); // from left to right
    expect(run("100 / 5 / 2")).toBe(10);
  });

  it("does what a circuit does with bits: & | ^ ! on 0 and 1", () => {
    for (const a of [0, 1]) {
      for (const b of [0, 1]) {
        expect(run("A & B", { A: a, B: b })).toBe(a & b);
        expect(run("A | B", { A: a, B: b })).toBe(a | b);
        expect(run("A ^ B", { A: a, B: b })).toBe(a ^ b);
        expect(run("!A", { A: a })).toBe(1 - a);
        expect(run("~A", { A: a })).toBe(1 - a); // a hardware person's NOT
      }
    }
  });

  it("accepts the words and, or, xor and not, in any case", () => {
    expect(run("(A and not B) or C", { A: 1, B: 0, C: 0 })).toBe(1);
    expect(run("(A AND NOT B) OR C", { A: 0, B: 0, C: 0 })).toBe(0);
    expect(run("A xor B", { A: 1, B: 1 })).toBe(0);
    expect(run("not A", { A: 0 })).toBe(1);
  });

  it("counts: A + B + C >= 2 is a majority", () => {
    const majority = (a: number, b: number, c: number): number => run("A + B + C >= 2", { A: a, B: b, C: c });
    expect([majority(0, 0, 1), majority(1, 1, 0), majority(1, 1, 1), majority(0, 0, 0)]).toEqual([0, 1, 1, 0]);
  });

  it("chooses with ? : and nests it from the right", () => {
    expect(run("S ? 7 : 9", { S: 1 })).toBe(7);
    expect(run("S ? 7 : 9", { S: 0 })).toBe(9);
    expect(run("A ? 1 : B ? 2 : 3", { A: 0, B: 1 })).toBe(2);
    expect(run("A ? 1 : B ? 2 : 3", { A: 0, B: 0 })).toBe(3);
  });

  it("knows % / << >> and a minus sign", () => {
    expect(run("7 % 4")).toBe(3);
    expect(run("7 / 2")).toBe(3);
    expect(run("1 << 3")).toBe(8);
    expect(run("12 >> 2")).toBe(3);
    expect(run("-3 + 5")).toBe(2);
  });

  it("reads the gates as functions", () => {
    for (const a of [0, 1]) {
      for (const b of [0, 1]) {
        for (const c of [0, 1]) {
          const values = { A: a, B: b, C: c };
          expect(run("AND(A, B, C)", values)).toBe(a & b & c);
          expect(run("OR(A, B, C)", values)).toBe(a | b | c);
          expect(run("NAND(A, B)", values)).toBe(1 - (a & b));
          expect(run("NOR(A, B)", values)).toBe(1 - (a | b));
          expect(run("XOR(A, B, C)", values)).toBe(a ^ b ^ c);
          expect(run("XNOR(A, B)", values)).toBe(1 - (a ^ b));
          expect(run("NOT(A)", values)).toBe(1 - a);
          expect(run("BUF(A)", values)).toBe(a);
        }
      }
    }
    expect(run("and(A, or(B, C))", { A: 1, B: 0, C: 1 })).toBe(1); // lower case too
  });

  it("calls anything non-zero true inside && || ! and the gates", () => {
    expect(run("A && B", { A: 2, B: 3 })).toBe(1);
    expect(run("!A", { A: 2 })).toBe(0);
  });

  it("can't divide by zero", () => {
    expect(() => run("A / 0", { A: 1 })).toThrow(/divides by zero/);
    expect(() => run("A % 0", { A: 1 })).toThrow(FormulaError);
  });
});

describe("parseFormula: refusing what is unclear or wrong", () => {
  const refuses = (text: string): string => {
    try {
      parseFormula(text);
    } catch (error) {
      if (error instanceof FormulaError) return error.message;
      throw error;
    }
    throw new Error(`“${text}” was accepted`);
  };

  it("won't guess the order of & | ^ against a comparison (C and Python disagree)", () => {
    expect(refuses("A & B == C")).toMatch(/isn't clear what comes first/);
    expect(refuses("A == B & C")).toMatch(/isn't clear what comes first/);
    expect(refuses("A + B ^ C > D")).toMatch(/isn't clear/);
    expect(() => parseFormula("(A & B) == C")).not.toThrow();
    expect(() => parseFormula("A & (B == C)")).not.toThrow();
    expect(() => parseFormula("A == B && C == D")).not.toThrow(); // && is below ==, in every language
    expect(() => parseFormula("A & B & C")).not.toThrow();
  });

  it("says what is missing", () => {
    expect(refuses("(A & B")).toMatch(/needs a “\)”.*the end of the formula/);
    expect(refuses("A &")).toMatch(/expected a name, a number or “\(”, but found the end of the formula/);
    expect(refuses("S ? A")).toMatch(/needs a “:”/);
    expect(refuses("AND(A, B")).toMatch(/AND\( needs a “\)”/);
    expect(refuses("")).toMatch(/expected a name/);
  });

  it("refuses leftovers, unknown characters and words with nothing to work on", () => {
    expect(refuses("A B")).toMatch(/didn't expect “B”/);
    expect(refuses("A # B")).toMatch(/“#” can't be used/);
    expect(refuses("A and")).toMatch(/expected a name/);
    expect(refuses("and A")).toMatch(/“and” is an operator/);
    expect(refuses("2A")).toMatch(/names start with a letter/);
    expect(refuses("A)")).toMatch(/didn't expect “\)”/);
  });
});

describe("namesIn, printFormula", () => {
  it("lists each name once, in order of appearance, and skips numbers and gate names", () => {
    expect(namesIn(parseFormula("(B & A) | (A & !C) | AND(B, D) | 1"))).toEqual(["B", "A", "C", "D"]);
  });

  it("writes a formula back so that it means the same", () => {
    for (const text of ["A ^ B ^ CIN", "SEL ? D1 : D0", "A + B * C >= 2", "!(A & B) | NOR(A, B)", "-A + 3", "a ? b ? 1 : 2 : 3"]) {
      const again = parseFormula(printFormula(parseFormula(text)));
      for (let row = 0; row < 64; row++) {
        const values: Record<string, number> = { A: row & 1, B: (row >> 1) & 1, C: (row >> 2) & 1, CIN: (row >> 3) & 1, SEL: (row >> 4) & 1, D0: (row >> 5) & 1, D1: row & 1, a: row & 1, b: (row >> 1) & 1 };
        const valueOf = (name: string): number => values[name] ?? 0;
        expect(evaluateFormula(again, valueOf)).toBe(evaluateFormula(parseFormula(text), valueOf));
      }
    }
  });
});
