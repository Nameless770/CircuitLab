import { describe, expect, it } from "vitest";
import { buildCircuit, designCircuit, namesAskedFor, onlyGateAskedFor, requestProblems, type ChatMessage, type LanguageModel } from "@circuitlab/assistant";

/** The circuit a spec makes. */
function circuitOf(inputs: string[], outputs: Record<string, string>, signals: Record<string, string> = {}) {
  const result = buildCircuit({
    name: "Test",
    inputs,
    signals: Object.entries(signals).map(([name, formula]) => ({ name, formula })),
    outputs: Object.entries(outputs).map(([name, formula]) => ({ name, formula })),
  });
  if (!result.ok) throw new Error(result.problems.join(" | "));
  return result.circuit;
}

describe("namesAskedFor", () => {
  it("expands a run of numbered names, however it's written", () => {
    expect(namesAskedFor("outputs Y0 to Y3")).toEqual(["Y0", "Y1", "Y2", "Y3"]);
    expect(namesAskedFor("data inputs D0-D2, select S1 and S0")).toEqual(["D0", "D1", "D2"]);
    expect(namesAskedFor("inputs I0..I2")).toEqual(["I0", "I1", "I2"]);
    expect(namesAskedFor("A2 through A4")).toEqual(["A2", "A3", "A4"]);
    expect(namesAskedFor("Outputs Y0 TO Y1")).toEqual(["Y0", "Y1"]);
  });

  it("finds several runs", () => {
    expect(namesAskedFor("inputs A0 to A1 and B0 to B1")).toEqual(["A0", "A1", "B0", "B1"]);
  });

  it("is not fooled by sizes, plain numbers, or different names", () => {
    for (const request of ["a 3-to-8 decoder", "a 4-to-1 multiplexer", "numbers 0 to 3", "a 2-bit adder", "inputs A1 to B2", "outputs Y3 to Y1", "from X0 to X999"]) {
      expect(namesAskedFor(request), request).toEqual([]);
    }
  });
});

describe("onlyGateAskedFor", () => {
  it("hears 'only NAND gates' and 'only NOR gates'", () => {
    expect(onlyGateAskedFor("Make an XOR gate using only NAND gates.")).toBe("NAND");
    expect(onlyGateAskedFor("built only from NOR gates")).toBe("NOR");
    expect(onlyGateAskedFor("just nand gates please")).toBe("NAND");
    expect(onlyGateAskedFor("exclusively with NOR gates")).toBe("NOR");
  });

  it("doesn't take 'from NAND gates' for 'only': a gated D latch from NANDs has an inverter", () => {
    expect(onlyGateAskedFor("a gated D latch from NAND gates")).toBeUndefined();
    expect(onlyGateAskedFor("a latch made of two NOR gates")).toBeUndefined();
    expect(onlyGateAskedFor("an AND gate")).toBeUndefined();
  });
});

describe("requestProblems", () => {
  it("is quiet when nothing is wrong", () => {
    expect(requestProblems("outputs Y0 to Y1", circuitOf(["A"], { Y0: "!A", Y1: "A" }))).toEqual([]);
    expect(requestProblems("a half adder", circuitOf(["A", "B"], { S: "A ^ B" }))).toEqual([]);
  });

  it("says which of the requested names are missing", () => {
    const circuit = circuitOf(["A2", "A1", "A0"], { Y0: "A2 & A1 & A0" });
    expect(requestProblems("outputs Y0 to Y7", circuit)).toEqual([
      "The request names “Y1”, “Y2”, “Y3”, “Y4” and 3 more, but the circuit has no input or output with those names. Use the names the request gives, every one of them.",
    ]);
    expect(requestProblems("outputs Y0 to Y1", circuit)).toEqual(["The request names “Y1”, but the circuit has no input or output with that name. Use the names the request gives, every one of them."]);
  });

  it("insists on the one kind of gate that was asked for, and says how", () => {
    const wrong = circuitOf(["A", "B"], { Y: "NOT(NOR(A, B))" });
    expect(requestProblems("an OR gate using only NOR gates", wrong)).toEqual(["The request says to use only NOR gates, but the circuit also has NOT gates. Make every gate a NOR: NOT(x) is NOR(x, x), and so on."]);
    const right = circuitOf(["A", "B"], { Y: "NOR(NOR(A, B), NOR(A, B))" });
    expect(requestProblems("an OR gate using only NOR gates", right)).toEqual([]);
    expect(requestProblems("an OR gate", wrong)).toEqual([]); // not asked for
  });

  it("finds a latch that never settles, and says what a latch looks like", () => {
    const selfFeeding = circuitOf(["S", "R"], { Q: "q", QBAR: "qbar" }, { q: "NOR(R, q)", qbar: "NOR(S, qbar)" });
    const [problem] = requestProblems("an SR latch", selfFeeding);
    expect(problem).toMatch(/^The loop of gates .* never settles/);
    expect(problem).toContain("q = NOR(R, qbar) and qbar = NOR(S, q)");
  });

  it("accepts a real latch, and a bigger circuit with a loop", () => {
    expect(requestProblems("an SR latch", circuitOf(["S", "R"], { Q: "q", QBAR: "qbar" }, { q: "NOR(R, qbar)", qbar: "NOR(S, q)" }))).toEqual([]);
    const gated = circuitOf(["D", "EN"], { Q: "q", QBAR: "qbar" }, { s: "NAND(D, EN)", r: "NAND(NOT(D), EN)", q: "NAND(s, qbar)", qbar: "NAND(r, q)" });
    expect(requestProblems("a gated D latch", gated)).toEqual([]);
  });

  it("tries a loop with many inputs in a few patterns, without trying them all", () => {
    const inputs = Array.from({ length: 12 }, (_, index) => `I${index}`);
    const circuit = circuitOf(inputs, { Q: "q" }, { q: `NOR(${inputs.join(", ")}, q)` });
    expect(requestProblems("a loop", circuit)[0]).toMatch(/never settles/);
  });
});

/** A model that answers from a list. */
function scripted(...replies: string[]): LanguageModel & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    name: "scripted",
    calls,
    async chat(messages) {
      calls.push([...messages]);
      const next = replies.shift();
      if (next === undefined) throw new Error("asked too often");
      return next;
    },
  };
}
const answer = (inputs: string[], outputs: Record<string, string>, signals: Record<string, string> = {}): string =>
  JSON.stringify({
    idea: "idea",
    name: "Test",
    inputs,
    signals: Object.entries(signals).map(([name, formula]) => ({ name, formula })),
    outputs: Object.entries(outputs).map(([name, formula]) => ({ name, formula })),
  });

describe("designCircuit asks again when a check fails", () => {
  it("a missing output name: tells the model, and takes the corrected circuit", async () => {
    const model = scripted(answer(["A", "B"], { Y0: "A & B" }), answer(["A", "B"], { Y0: "A & B", Y1: "A | B" }));
    const design = await designCircuit(model, { request: "inputs A and B, outputs Y0 to Y1" });
    expect(design.ok && design.attempts).toBe(2);
    expect(model.calls[1]?.[3]?.content).toContain("The request names “Y1”");
  });

  it("an 'only NAND' request answered with other gates: tells the model, and takes the NAND-only circuit", async () => {
    const model = scripted(answer(["A", "B"], { Y: "A & B" }), answer(["A", "B"], { Y: "NAND(NAND(A, B), NAND(A, B))" }));
    const design = await designCircuit(model, { request: "an AND gate using only NAND gates" });
    expect(design.ok && design.attempts).toBe(2);
    expect(model.calls[1]?.[3]?.content).toContain("only NAND gates, but the circuit also has AND gates");
  });

  it("a latch that never settles: tells the model, then gives up if it can't fix it", async () => {
    const bad = answer(["S", "R"], { Q: "q" }, { q: "NOR(R, q)" });
    const model = scripted(bad, bad, bad);
    const design = await designCircuit(model, { request: "an SR latch" });
    expect(design.ok).toBe(false);
    expect(!design.ok && design.reason === "invalid" && design.problems[0]).toMatch(/never settles/);
    expect(model.calls).toHaveLength(3);
  });
});
