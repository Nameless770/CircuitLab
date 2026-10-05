import { parseNetlist } from "@circuitlab/netlist";
import { describe, expect, it } from "vitest";
import {
  AssistantError,
  DEFAULT_ATTEMPTS,
  MAX_DESCRIBED_GATES,
  MAX_REQUEST_CHARS,
  SPEC_SCHEMA,
  designCircuit,
  readAnswer,
  type AttemptInfo,
  type ChatMessage,
  type ChatOptions,
  type LanguageModel,
} from "@circuitlab/assistant";
import { random, randomCircuit } from "../../engine/test/fixtures";

/** A model that answers from a list, and remembers everything it was asked. */
class ScriptedModel implements LanguageModel {
  readonly name = "scripted";
  readonly calls: { messages: ChatMessage[]; options: ChatOptions }[] = [];
  private readonly replies: (string | Error)[];

  constructor(...replies: (string | Error)[]) {
    this.replies = replies;
  }

  async chat(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<string> {
    this.calls.push({ messages: [...messages], options });
    const next = this.replies.shift();
    if (next === undefined) throw new Error("the model was asked more often than the test expected");
    if (next instanceof Error) throw next;
    return next;
  }
}

/** What a model answers: the JSON of an answer. */
function answer(parts: { idea?: string; name?: string; inputs?: string[]; signals?: Record<string, string>; outputs?: Record<string, string> } = {}): string {
  const list = (record: Record<string, string> = {}): { name: string; formula: string }[] => Object.entries(record).map(([name, formula]) => ({ name, formula }));
  return JSON.stringify({ idea: parts.idea ?? "An idea.", name: parts.name ?? "Test", inputs: parts.inputs ?? ["A", "B"], signals: list(parts.signals), outputs: list(parts.outputs ?? { Y: "A & B" }) });
}

describe("designCircuit: the first answer is good", () => {
  it("builds the circuit and gives back the netlist, the circuit and the model's idea", async () => {
    const model = new ScriptedModel(answer({ idea: "SUM is A xor B.", name: "Half adder", outputs: { SUM: "A ^ B", CARRY: "A & B" } }));
    const design = await designCircuit(model, { request: "a half adder" });
    expect(design.ok).toBe(true);
    if (!design.ok) return;
    expect(design.attempts).toBe(1);
    expect(design.idea).toBe("SUM is A xor B.");
    expect(design.netlist).toContain("xor1 = XOR(A, B)");
    expect(parseNetlist(design.netlist)).toEqual(design.circuit);
    expect(design.circuit.name).toBe("Half adder");
  });

  it("asks with the schema, a system prompt that holds the instructions and matching recipes, and the request", async () => {
    const model = new ScriptedModel(answer());
    await designCircuit(model, { request: "  a full adder  " });
    const [call] = model.calls;
    expect(call?.options.format).toEqual(SPEC_SCHEMA);
    expect(call?.messages.map((message) => message.role)).toEqual(["system", "user"]);
    const [system, user] = call?.messages ?? [];
    expect(system?.content).toContain("Answer with one JSON object");
    expect(system?.content).toContain("Request: a full adder with inputs A, B and CIN"); // the recipe for what was asked
    expect(user?.content).toBe("Design this circuit: a full adder");
  });

  it("passes the signal on, so Cancel can stop the request", async () => {
    const model = new ScriptedModel(answer());
    const controller = new AbortController();
    await designCircuit(model, { request: "x" }, { signal: controller.signal });
    expect(model.calls[0]?.options.signal).toBe(controller.signal);
  });

  it("cuts a formula where the model ran on into the closing brackets of the JSON", async () => {
    const model = new ScriptedModel(answer({ outputs: { Y: "A & B}]}assistant{" } }));
    const design = await designCircuit(model, { request: "an and gate" });
    expect(design.ok).toBe(true);
    expect(design.ok && design.netlist).toContain("and1 = AND(A, B)");
  });
});

describe("designCircuit: a second chance", () => {
  it("sends back what was wrong, with the model's own answer, and uses the corrected one", async () => {
    const bad = answer({ outputs: { Y: "A & C" } });
    const model = new ScriptedModel(bad, answer({ outputs: { Y: "A & B" } }));
    const seen: AttemptInfo[] = [];
    const design = await designCircuit(model, { request: "an and gate" }, { onAttempt: (info) => seen.push(info) });

    expect(design.ok && design.attempts).toBe(2);
    expect(model.calls).toHaveLength(2);
    const second = model.calls[1]?.messages ?? [];
    expect(second.map((message) => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(second[2]?.content).toBe(bad);
    expect(second[3]?.content).toBe("That can't be used, because:\n- The formula for “Y” uses “C”, but there is no input or signal with that name.\nAnswer with the corrected circuit, in the same format.");
    expect(seen).toEqual([
      { attempt: 1, of: DEFAULT_ATTEMPTS, problems: [] },
      { attempt: 2, of: DEFAULT_ATTEMPTS, problems: ["The formula for “Y” uses “C”, but there is no input or signal with that name."] },
    ]);
  });

  it("gives up after three answers, reports the last one's problems, and doesn't let the conversation grow", async () => {
    const model = new ScriptedModel(answer({ outputs: { Y: "A & X" } }), answer({ outputs: { Y: "A & Y2" } }), answer({ outputs: { Y: "A & Z" } }));
    const design = await designCircuit(model, { request: "an and gate" });
    expect(design).toEqual({ ok: false, reason: "invalid", problems: ["The formula for “Y” uses “Z”, but there is no input or signal with that name."], attempts: 3 });
    expect(model.calls.map((call) => call.messages.length)).toEqual([2, 4, 4]); // never longer than one repair deep
  });

  it("tries as often as it's allowed to", async () => {
    const model = new ScriptedModel(answer({ outputs: { Y: "A & X" } }));
    const design = await designCircuit(model, { request: "an and gate" }, { attempts: 1 });
    expect(design.ok).toBe(false);
    expect(model.calls).toHaveLength(1);
  });

  it("repairs a reply that isn't JSON, or isn't the right shape", async () => {
    const model = new ScriptedModel("Sure! Here you go: a & b", '{"inputs": "A"}', answer());
    const design = await designCircuit(model, { request: "an and gate" });
    expect(design.ok && design.attempts).toBe(3);
    expect(model.calls[1]?.messages[3]?.content).toContain("The answer was not valid JSON");
    expect(model.calls[2]?.messages[3]?.content).toContain('The answer must have "inputs"');
  });
});

describe("designCircuit: when the model says it can't", () => {
  it("shows the model's own explanation, and doesn't ask again", async () => {
    const model = new ScriptedModel(answer({ idea: "A recipe for pancakes is not a circuit.", inputs: [], outputs: {} }));
    const design = await designCircuit(model, { request: "pancakes" });
    expect(design).toEqual({ ok: false, reason: "declined", message: "A recipe for pancakes is not a circuit.", attempts: 1 });
    expect(model.calls).toHaveLength(1);
  });

  it("has a sentence of its own when the model said nothing", async () => {
    const design = await designCircuit(new ScriptedModel(answer({ idea: "", outputs: {} })), { request: "pancakes" });
    expect(!design.ok && design.reason === "declined" && design.message).toMatch(/couldn't make a circuit/);
  });
});

describe("designCircuit: requests that can't be used", () => {
  const refused = async (input: Parameters<typeof designCircuit>[1], model = new ScriptedModel()): Promise<AssistantError> => {
    try {
      await designCircuit(model, input);
    } catch (error) {
      expect(model.calls).toHaveLength(0); // nothing was sent to the model
      if (error instanceof AssistantError) return error;
      throw error;
    }
    throw new Error("the request was accepted");
  };

  it("needs some words", async () => {
    const error = await refused({ request: "   " });
    expect([error.code, error.message]).toEqual(["invalid-request", "Write what circuit you want first."]);
  });

  it("can't be longer than a few sentences", async () => {
    const error = await refused({ request: "x".repeat(MAX_REQUEST_CHARS + 1) });
    expect(error.code).toBe("invalid-request");
    expect(error.message).toContain(`${MAX_REQUEST_CHARS + 1} characters`);
  });

  it("can't change a circuit that is too big, or has names a formula can't hold", async () => {
    const big = await refused({ request: "invert it", current: randomCircuit(random(3), 4, MAX_DESCRIBED_GATES) });
    expect(big.message).toMatch(/can change circuits of up to/);
    const odd = await refused({ request: "invert it", current: parseNetlist("a.b = INPUT\ny = OUTPUT(a.b)\n") });
    expect(odd.message).toContain("“a.b”");
  });
});

describe("designCircuit: changing a circuit", () => {
  it("shows the model the circuit in its own format, and says what to change", async () => {
    const model = new ScriptedModel(answer({ outputs: { S: "A ^ B", C: "A & B", NS: "!(A ^ B)" } }));
    const current = parseNetlist('.name "Half adder"\nA = INPUT\nB = INPUT\nsum = XOR(A, B)\ncarry = AND(A, B)\nS = OUTPUT(sum)\nC = OUTPUT(carry)\n');
    const design = await designCircuit(model, { request: "Add an output NS, the opposite of S.", current });
    expect(design.ok).toBe(true);
    const user = model.calls[0]?.messages[1]?.content ?? "";
    expect(user).toMatch(/^Here is the current circuit:\n\{.*\}\nChange it like this: Add an output NS, the opposite of S\.\nAnswer with the complete new circuit\.$/s);
    const shown = readAnswer(/\{.*\}/s.exec(user)?.[0] ?? "");
    expect(shown.ok && shown.answer.spec.outputs).toEqual([
      { name: "S", formula: "A ^ B" },
      { name: "C", formula: "A & B" },
    ]);
  });
});

describe("designCircuit: when Ollama isn't there", () => {
  it("lets the error through as it is, whichever attempt it happens in", async () => {
    const down = new AssistantError("ollama-unreachable", "Can't reach Ollama.");
    await expect(designCircuit(new ScriptedModel(down), { request: "x" })).rejects.toBe(down);
    const model = new ScriptedModel(answer({ outputs: { Y: "A & X" } }), down);
    await expect(designCircuit(model, { request: "x" })).rejects.toBe(down);
    expect(model.calls).toHaveLength(2);
  });
});

describe("readAnswer", () => {
  it("reads a good answer, and trims the idea", () => {
    const read = readAnswer(answer({ idea: "  Because.  " }));
    expect(read.ok && read.answer.idea).toBe("Because.");
  });

  it("says what is wrong with anything else", () => {
    expect(readAnswer("[]")).toEqual({ ok: false, problem: "The answer must be one JSON object in the format shown." });
    expect(readAnswer("null").ok).toBe(false);
    expect(readAnswer('{"inputs":["A"],"signals":[],"outputs":[{"name":"Y"}]}').ok).toBe(false);
    expect(readAnswer('{"inputs":[1],"signals":[],"outputs":[]}').ok).toBe(false);
    expect(readAnswer("{").ok).toBe(false);
  });

  it("copes with a missing idea or name", () => {
    const read = readAnswer('{"inputs":["A"],"signals":[],"outputs":[{"name":"Y","formula":"A"}]}');
    expect(read.ok && [read.answer.idea, read.answer.spec.name]).toEqual(["", ""]);
  });
});
