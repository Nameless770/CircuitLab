import type { CircuitSpec } from "./build";

/**
 * Worked examples that go into the prompt. A small model copies and adapts what it is shown much
 * better than it follows instructions, so each request gets the recipes that look most like it.
 * Every recipe here is checked against ordinary code in test/cookbook.test.ts, so what the model
 * copies is right.
 */
export interface Recipe {
  readonly id: string;
  /** Words that, found in a request, make this recipe a good example for it. Longer ones count for more. */
  readonly keywords: readonly string[];
  /** How a person would ask for it. */
  readonly request: string;
  /** What the model says first: one sentence. */
  readonly idea: string;
  readonly spec: CircuitSpec;
}

const circuit = (name: string, inputs: string[], outputs: Record<string, string>, signals: Record<string, string> = {}): CircuitSpec => ({
  name,
  inputs,
  signals: Object.entries(signals).map(([key, formula]) => ({ name: key, formula })),
  outputs: Object.entries(outputs).map(([key, formula]) => ({ name: key, formula })),
});

/** 2-bit adder: the total of A1A0 and B1B0, and from it each bit. */
const TOTAL_2BIT = "(2 * A1 + A0 + 2 * B1 + B0)";

export const RECIPES: readonly Recipe[] = [
  {
    id: "half-adder",
    keywords: ["half adder", "half-adder"],
    request: "a half adder with inputs A and B and outputs SUM and CARRY",
    idea: "SUM is 1 when exactly one input is 1 (A xor B), and CARRY is 1 when both are (A and B).",
    spec: circuit("Half adder", ["A", "B"], { SUM: "A ^ B", CARRY: "A & B" }),
  },
  {
    id: "full-adder",
    keywords: ["full adder", "full-adder", "adder", "carry"],
    request: "a full adder with inputs A, B and CIN and outputs SUM and COUT",
    idea: "SUM is 1 when an odd number of the three inputs are 1, and COUT is 1 when at least two are.",
    spec: circuit("Full adder", ["A", "B", "CIN"], { SUM: "A ^ B ^ CIN", COUT: "A + B + CIN >= 2" }),
  },
  {
    id: "adder-2bit",
    keywords: ["2-bit adder", "two-bit adder", "bit adder", "adder", "add two", "sum of"],
    request: "a 2-bit adder with inputs A1, A0, B1, B0 and outputs S2, S1, S0: the sum of the numbers A1A0 and B1B0",
    idea: "Add the two numbers; S2, S1 and S0 are the bits of the total, so divide by 4, 2 or 1 and keep what is left after dividing by 2.",
    spec: circuit("2-bit adder", ["A1", "A0", "B1", "B0"], { S2: `${TOTAL_2BIT} / 4 % 2`, S1: `${TOTAL_2BIT} / 2 % 2`, S0: `${TOTAL_2BIT} % 2` }),
  },
  {
    id: "subtractor",
    keywords: ["subtractor", "borrow", "minus", "subtract"],
    request: "a half subtractor with inputs A and B and outputs DIFF and BORROW, computing A minus B",
    idea: "DIFF is 1 when the inputs differ, and BORROW is 1 when B is 1 and A is 0, because then 1 must be borrowed.",
    spec: circuit("Half subtractor", ["A", "B"], { DIFF: "A ^ B", BORROW: "!A & B" }),
  },
  {
    id: "mux-2to1",
    keywords: ["2-to-1", "2 to 1", "two to one", "multiplexer", "mux", "selector", "select"],
    request: "a 2-to-1 multiplexer with inputs D0, D1 and SEL and output Y (Y is D1 when SEL is 1, else D0)",
    idea: "SEL chooses which data input appears on Y.",
    spec: circuit("2-to-1 multiplexer", ["D0", "D1", "SEL"], { Y: "SEL ? D1 : D0" }),
  },
  {
    id: "mux-4to1",
    keywords: ["4-to-1", "4 to 1", "four to one", "multiplexer", "mux", "selector"],
    request: "a 4-to-1 multiplexer with data inputs D0, D1, D2, D3, select inputs S1 and S0 and output Y; Y is the data input whose number is S1S0",
    idea: "S1 picks the pair, and S0 picks one of the two in it.",
    spec: circuit("4-to-1 multiplexer", ["D0", "D1", "D2", "D3", "S1", "S0"], { Y: "S1 ? (S0 ? D3 : D2) : (S0 ? D1 : D0)" }),
  },
  {
    id: "decoder-2to4",
    keywords: ["decoder", "decode", "one-hot", "one hot"],
    request: "a 2-to-4 decoder with inputs A1 and A0 and outputs Y0, Y1, Y2 and Y3, where Yn is 1 only when the number A1A0 equals n",
    idea: "Exactly one output is 1: the one whose number is the value of the two inputs.",
    spec: circuit("2-to-4 decoder", ["A1", "A0"], { Y0: "A1 * 2 + A0 == 0", Y1: "A1 * 2 + A0 == 1", Y2: "A1 * 2 + A0 == 2", Y3: "A1 * 2 + A0 == 3" }),
  },
  {
    id: "comparator-1bit",
    keywords: ["comparator", "compare", "greater", "bigger", "larger", "less", "smaller", "magnitude"],
    request: "a 1-bit comparator with inputs A and B and outputs GT, EQ and LT",
    idea: "Exactly one output is 1: GT when A is greater than B, EQ when they are equal, LT when A is less than B.",
    spec: circuit("1-bit comparator", ["A", "B"], { GT: "A > B", EQ: "A == B", LT: "A < B" }),
  },
  {
    id: "equal-2bit",
    keywords: ["equal", "equality", "same", "match", "identical"],
    request: "a circuit with inputs A1, A0, B1, B0 and output EQ that is 1 when the 2-bit numbers A1A0 and B1B0 are equal",
    idea: "Turn each pair of bits into a number and compare the numbers.",
    spec: circuit("2-bit equality", ["A1", "A0", "B1", "B0"], { EQ: "A1 * 2 + A0 == B1 * 2 + B0" }),
  },
  {
    id: "majority",
    keywords: ["majority", "at least two", "two of", "more than half", "at least 2", "2 of"],
    request: "a circuit with inputs A, B and C and output M that is 1 when at least two of the inputs are 1",
    idea: "Add the three inputs: two or more ones make a total of at least 2.",
    spec: circuit("Majority", ["A", "B", "C"], { M: "A + B + C >= 2" }),
  },
  {
    id: "threshold",
    keywords: ["at least", "at most", "exactly", "only one", "none of", "all of", "number of inputs", "how many", "count"],
    request: "a circuit with inputs A, B, C and D and output Y that is 1 when exactly two of the inputs are 1",
    idea: "Add the four inputs and compare the total.",
    spec: circuit("Exactly two", ["A", "B", "C", "D"], { Y: "A + B + C + D == 2" }),
  },
  {
    id: "parity",
    keywords: ["parity", "odd number", "even number", "odd", "even"],
    request: "a circuit with inputs A, B, C and D and output P that is 1 when an even number of the inputs are 1",
    idea: "Add the inputs and check whether the total is even.",
    spec: circuit("Even parity", ["A", "B", "C", "D"], { P: "(A + B + C + D) % 2 == 0" }),
  },
  {
    id: "sr-latch",
    keywords: ["sr latch", "latch", "flip-flop", "flip flop", "memory", "remember", "store a bit", "cross-coupled"],
    request: "an SR latch built from two cross-coupled NOR gates, with inputs S and R and outputs Q and QBAR",
    idea: "Two NOR gates feed each other, which makes the circuit remember a bit: S sets Q to 1, R resets it to 0.",
    spec: circuit("SR latch", ["S", "R"], { Q: "q", QBAR: "qbar" }, { q: "NOR(R, qbar)", qbar: "NOR(S, q)" }),
  },
  {
    id: "d-latch",
    keywords: ["d latch", "gated", "data latch", "transparent", "enable"],
    request: "a gated D latch built from NAND gates, with inputs D and EN and outputs Q and QBAR",
    idea: "While EN is 1 the latch copies D; while EN is 0 it keeps what it had.",
    spec: circuit("Gated D latch", ["D", "EN"], { Q: "q", QBAR: "qbar" }, { s: "NAND(D, EN)", r: "NAND(NOT(D), EN)", q: "NAND(s, qbar)", qbar: "NAND(r, q)" }),
  },
  {
    id: "xor-from-nand",
    keywords: ["only nand", "using nand", "from nand", "nand gates", "nand only", "universal"],
    request: "an XOR gate built only from NAND gates, with inputs A and B and output Y",
    idea: "The classic four-NAND XOR: one NAND of both inputs, which then feeds a NAND with each input, and a last NAND joins those two.",
    spec: circuit("XOR from NAND gates", ["A", "B"], { Y: "NAND(NAND(A, NAND(A, B)), NAND(B, NAND(A, B)))" }),
  },
  {
    id: "expression",
    keywords: ["expression", "formula", "equation", "boolean", "and not", "or not", "not a", "not b"],
    request: "a circuit with inputs A, B and C and output Y equal to (A and not B) or C",
    idea: "Y is 1 when A is 1 and B is 0, or when C is 1.",
    spec: circuit("Expression", ["A", "B", "C"], { Y: "(A & !B) | C" }),
  },
];

/** Shown when nothing in the request matches a recipe: one of each way of writing a formula. */
const GENERIC = ["majority", "mux-2to1", "expression"];

/** How many examples a prompt gets. More of them, and a small model starts copying noise from them. */
export const EXAMPLES_PER_PROMPT = 3;

/** The recipes that look most like the request, best first. Always `EXAMPLES_PER_PROMPT` of them. */
export function recipesFor(request: string): Recipe[] {
  const text = request.toLowerCase();
  const scored = RECIPES.map((recipe) => ({ recipe, score: recipe.keywords.filter((word) => text.includes(word)).reduce((total, word) => total + word.length, 0) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score); // a stable sort: on a tie, the earlier recipe wins
  const chosen = scored.slice(0, EXAMPLES_PER_PROMPT).map((entry) => entry.recipe);
  for (const id of GENERIC) {
    if (chosen.length >= EXAMPLES_PER_PROMPT) break;
    const recipe = RECIPES.find((candidate) => candidate.id === id);
    if (recipe !== undefined && !chosen.includes(recipe)) chosen.push(recipe);
  }
  return chosen;
}
