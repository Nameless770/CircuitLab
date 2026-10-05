import { describe, expect, it } from "vitest";
import { minimize, type Term } from "@circuitlab/assistant";

/** What a list of terms, OR-ed together, gives for a row. */
function outputOf(terms: readonly Term[], variables: number, row: number): number {
  const bits = Array.from({ length: variables }, (_, index) => (row >> (variables - 1 - index)) & 1);
  return terms.some((term) => term.every((literal, index) => literal === "any" || literal === bits[index])) ? 1 : 0;
}

describe("minimize", () => {
  it("gives no terms for a table of zeros, and one term that matters nothing for a table of ones", () => {
    expect(minimize([0, 0, 0, 0], 2)).toEqual([]);
    expect(minimize([1, 1, 1, 1], 2)).toEqual([["any", "any"]]);
  });

  it("reproduces every table of up to 3 inputs exactly (all 256 of them)", () => {
    for (let variables = 1; variables <= 3; variables++) {
      const rows = 2 ** variables;
      for (let pattern = 0; pattern < 2 ** rows; pattern++) {
        const table = Array.from({ length: rows }, (_, row) => (pattern >> row) & 1);
        const terms = minimize(table, variables);
        expect(table.map((_, row) => outputOf(terms, variables, row))).toEqual(table);
      }
    }
  });

  it("reproduces tables of 4 to 8 inputs exactly", () => {
    let seed = 12345;
    const random = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (const variables of [4, 5, 6, 7, 8]) {
      for (const density of [0.1, 0.5, 0.9]) {
        const table = Array.from({ length: 2 ** variables }, () => (random() < density ? 1 : 0));
        const terms = minimize(table, variables);
        expect(table.map((_, row) => outputOf(terms, variables, row))).toEqual(table);
      }
    }
  });

  it("finds the small answer for well-known functions", () => {
    // Majority of three: AB + AC + BC.
    const majority = minimize([0, 0, 0, 1, 0, 1, 1, 1], 3);
    expect(majority).toHaveLength(3);
    expect(majority.every((term) => term.filter((literal) => literal !== "any").length === 2)).toBe(true);
    // A mux, S ? D1 : D0 with the inputs in the order D0 D1 S: two terms, the redundant D0.D1 left out.
    const mux = minimize(Array.from({ length: 8 }, (_, row) => ((row & 1) !== 0 ? (row >> 1) & 1 : row >> 2)), 3);
    expect(mux).toHaveLength(2);
    // Two inputs the same: A single term when one input decides.
    expect(minimize([0, 1, 0, 1], 2)).toEqual([["any", 1]]);
    // XOR can't be made smaller than its two terms.
    expect(minimize([0, 1, 1, 0], 2)).toHaveLength(2);
  });

  it("gives the same answer every time", () => {
    const table = [0, 1, 1, 0, 1, 1, 0, 1];
    expect(minimize(table, 3)).toEqual(minimize(table, 3));
  });
});
