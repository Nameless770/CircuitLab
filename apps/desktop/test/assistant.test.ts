import { AssistantError, type ChatMessage, type LanguageModel } from "@circuitlab/assistant";
import { NetlistError } from "@circuitlab/netlist";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_NETLIST_CHARS, PREVIEW_INPUTS, askAssistant, checkAssistant, chooseModel } from "../electron/assistant";
import type { AssistantProgress } from "../electron/bridge";
import { toProblem } from "../electron/offline";

describe("chooseModel: which of Ollama's models to use", () => {
  it("uses the one chosen in Settings, when it's there", () => {
    expect(chooseModel(["a:1b", "b:3b"], "b:3b")).toEqual({ model: "b:3b" });
  });

  it("uses the first (the newest) when none was chosen", () => {
    expect(chooseModel(["a:1b", "b:3b"], null)).toEqual({ model: "a:1b" });
  });

  it("falls back to the first when the chosen one was removed, and says so", () => {
    const chosen = chooseModel(["a:1b"], "gone:7b");
    expect(chosen.model).toBe("a:1b");
    expect(chosen.problem).toBe("The model “gone:7b” isn't installed in Ollama any more, so “a:1b” is used. Choose a model in Settings.");
  });

  it("has nothing to use when no model is installed, and says what to do", () => {
    const chosen = chooseModel([], null);
    expect(chosen.model).toBeNull();
    expect(chosen.problem).toContain("ollama pull");
    expect(chooseModel([], "x").model).toBeNull();
  });
});

// These tests answer for Ollama by replacing fetch: the desktop tests are checked as browser code, which has no web server.
afterEach(() => {
  vi.unstubAllGlobals();
});

const URL_OF_OLLAMA = "http://127.0.0.1:11434";

/** An Ollama that lists these models. */
function ollamaWith(models: { name: string; size: number; parameter_size?: string }[]): string {
  const body = { models: models.map((model) => ({ name: model.name, size: model.size, details: { parameter_size: model.parameter_size } })) };
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  return URL_OF_OLLAMA;
}

/** Nothing is listening: what Node's fetch does is fail with "fetch failed", and the reason in `cause`. */
function noOllama(): void {
  vi.stubGlobal("fetch", async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
  });
}

describe("checkAssistant: what Settings and the panel show about Ollama", () => {
  it("lists the models with their sizes, and picks one", async () => {
    const url = ollamaWith([
      { name: "llama3.2:3b", size: 2_019_393_189, parameter_size: "3.2B" },
      { name: "tiny", size: 100 },
    ]);
    const status = await checkAssistant(url, null);
    expect(status).toEqual({
      url,
      local: true,
      models: [
        { name: "llama3.2:3b", parameterSize: "3.2B", sizeGigabytes: 1.9 },
        { name: "tiny", sizeGigabytes: 0 },
      ],
      model: "llama3.2:3b",
    });
  });

  it("keeps the chosen model, or explains why another is used", async () => {
    const url = ollamaWith([{ name: "a", size: 1 }, { name: "b", size: 1 }]);
    expect((await checkAssistant(url, "b")).model).toBe("b");
    const gone = await checkAssistant(url, "c");
    expect([gone.model, gone.problem]).toEqual(["a", "The model “c” isn't installed in Ollama any more, so “a” is used. Choose a model in Settings."]);
  });

  it("says Ollama has nothing to use when it has no models", async () => {
    const status = await checkAssistant(ollamaWith([]), null);
    expect(status.model).toBeNull();
    expect(status.problem).toContain("no models");
  });

  it("says when Ollama isn't running, and doesn't fail", async () => {
    noOllama();
    const status = await checkAssistant(URL_OF_OLLAMA, null);
    expect(status.models).toEqual([]);
    expect(status.model).toBeNull();
    expect(status.problem).toContain(`Can't reach Ollama at ${URL_OF_OLLAMA}`);
  });

  it("says whether the address is this computer", async () => {
    noOllama();
    expect((await checkAssistant("http://192.168.1.20:11434", null)).local).toBe(false);
    expect((await checkAssistant("http://localhost:11434", null)).local).toBe(true);
  });
});

/** A model that answers from a list. */
function scripted(...replies: string[]): LanguageModel & { readonly calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    name: "scripted:1b",
    calls,
    async chat(messages) {
      calls.push([...messages]);
      const next = replies.shift();
      if (next === undefined) throw new Error("asked more often than expected");
      return next;
    },
  };
}
const answer = (inputs: string[], outputs: Record<string, string>, signals: Record<string, string> = {}, idea = "How it works."): string =>
  JSON.stringify({
    idea,
    name: "Made by the model",
    inputs,
    signals: Object.entries(signals).map(([name, formula]) => ({ name, formula })),
    outputs: Object.entries(outputs).map(([name, formula]) => ({ name, formula })),
  });

describe("askAssistant: the answer the window shows", () => {
  it("gives the checked netlist, the circuit as the window knows it, the idea, and the whole truth table", async () => {
    const model = scripted(answer(["A", "B", "CIN"], { SUM: "A ^ B ^ CIN", COUT: "A + B + CIN >= 2" }));
    const result = await askAssistant(model, { request: "a full adder" });
    expect(result.kind).toBe("circuit");
    if (result.kind !== "circuit") return;
    expect(result.model).toBe("scripted:1b");
    expect(result.attempts).toBe(1);
    expect(result.idea).toBe("How it works.");
    expect(result.netlist).toContain("xor1 = XOR(A, B, CIN)");
    expect(result.circuit.name).toBe("Made by the model");
    expect(result.circuit.summary).toEqual({ inputs: ["A", "B", "CIN"], outputs: ["SUM", "COUT"], feedbackLoop: null });
    expect(result.table?.totalRows).toBe(8);
    expect(result.table?.rows).toHaveLength(8);
    expect(result.table?.rows[7]).toMatchObject({ inputs: [1, 1, 1], outputs: [1, 1] });
  });

  it(`shows no table for more than ${PREVIEW_INPUTS} inputs, or a loop`, async () => {
    const wide = await askAssistant(scripted(answer(["A", "B", "C", "D", "E"], { Y: "A + B + C + D + E >= 3" })), { request: "x" });
    expect(wide.kind === "circuit" && wide.table).toBeNull();
    const latch = await askAssistant(scripted(answer(["S", "R"], { Q: "q", QBAR: "qbar" }, { q: "NOR(R, qbar)", qbar: "NOR(S, q)" })), { request: "an SR latch" });
    expect(latch.kind === "circuit" && latch.circuit.summary.feedbackLoop).not.toBeNull();
    expect(latch.kind === "circuit" && latch.table).toBeNull();
  });

  it("reports before each question to the model, with how many problems it is being asked to fix", async () => {
    const progress: AssistantProgress[] = [];
    const model = scripted(answer(["A"], { Y: "A & Z" }), answer(["A"], { Y: "!A" }));
    await askAssistant(model, { request: "an inverter" }, { onProgress: (p) => progress.push(p) });
    expect(progress).toEqual([
      { attempt: 1, of: 3, problems: 0 },
      { attempt: 2, of: 3, problems: 1 },
    ]);
  });

  it("passes on the model's refusal, and the problems of a model that couldn't do it", async () => {
    const declined = await askAssistant(scripted(answer([], {}, {}, "Not a circuit.")), { request: "pancakes" });
    expect(declined).toEqual({ kind: "declined", message: "Not a circuit." });
    const bad = answer(["A"], { Y: "A & Z" });
    const invalid = await askAssistant(scripted(bad, bad, bad), { request: "x" });
    expect(invalid).toEqual({ kind: "invalid", attempts: 3, problems: ["The formula for “Y” uses “Z”, but there is no input or signal with that name."] });
  });

  it("changes the netlist it is given, which the model sees in its own format", async () => {
    const model = scripted(answer(["A", "B"], { Y: "!(A & B)" }));
    const result = await askAssistant(model, { request: "Invert the output.", netlist: 'A = INPUT\nB = INPUT\nx = AND(A, B)\nY = OUTPUT(x)\n' });
    expect(result.kind).toBe("circuit");
    expect(model.calls[0]?.[1]?.content).toContain('"formula":"A & B"');
  });

  it("says what is wrong with a netlist to change that has mistakes, line by line", async () => {
    let caught: unknown;
    try {
      await askAssistant(scripted(), { request: "x", netlist: "A = INPUT\nY = OUTPUT(ghost)\n" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(NetlistError);
    expect(toProblem(caught)).toMatchObject({ code: "invalid-netlist", issues: [{ line: 2 }] });
  });

  it("refuses a netlist too long to change, before reading it", async () => {
    let caught: unknown;
    try {
      await askAssistant(scripted(), { request: "x", netlist: "#".repeat(MAX_NETLIST_CHARS + 1) });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect(toProblem(caught).code).toBe("too-large");
  });

  it("lets a request the assistant can't use through as the problem the window shows", async () => {
    let caught: unknown;
    try {
      await askAssistant(scripted(), { request: "   " });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AssistantError);
    expect(toProblem(caught)).toEqual({ code: "invalid-request", message: "Write what circuit you want first." });
  });
});

describe("toProblem for the assistant's errors", () => {
  it("keeps the assistant's own code and message", () => {
    expect(toProblem(new AssistantError("ollama-unreachable", "Can't reach Ollama."))).toEqual({ code: "ollama-unreachable", message: "Can't reach Ollama." });
    expect(toProblem(new AssistantError("cancelled", "Stopped.")).code).toBe("cancelled");
  });
});
