import type { CircuitSpec, Definition } from "./build";

/**
 * What the model answers with, as JSON. Ollama is given this schema and then only lets the model
 * write text that fits it, so the answer is always JSON of this shape (the formulas inside are
 * still free text: `buildCircuit` reads those).
 */
const DEFINITION = {
  type: "object",
  properties: { name: { type: "string" }, formula: { type: "string" } },
  required: ["name", "formula"],
  additionalProperties: false,
} as const;

export const SPEC_SCHEMA = {
  type: "object",
  properties: {
    idea: { type: "string" },
    name: { type: "string" },
    inputs: { type: "array", items: { type: "string" } },
    signals: { type: "array", items: DEFINITION },
    outputs: { type: "array", items: DEFINITION },
  },
  required: ["idea", "name", "inputs", "signals", "outputs"],
  additionalProperties: false,
} as const;

/** The model's answer, read. `idea` is its one-sentence explanation. */
export interface Answer {
  readonly idea: string;
  readonly spec: CircuitSpec;
}

/**
 * Reads the model's reply as an Answer. The schema should make a wrong shape impossible, but a
 * model that was cut off, or a server that ignores schemas, can still send anything.
 * @returns the answer, or a sentence saying what is wrong with the reply
 */
export function readAnswer(reply: string): { readonly ok: true; readonly answer: Answer } | { readonly ok: false; readonly problem: string } {
  let data: unknown;
  try {
    data = JSON.parse(reply);
  } catch {
    return { ok: false, problem: "The answer was not valid JSON. Answer with one JSON object in the format shown, and nothing else." };
  }
  if (!isRecord(data)) return { ok: false, problem: "The answer must be one JSON object in the format shown." };
  const inputs = data["inputs"];
  const signals = definitions(data["signals"]);
  const outputs = definitions(data["outputs"]);
  if (!Array.isArray(inputs) || !inputs.every((name) => typeof name === "string") || signals === undefined || outputs === undefined) {
    return { ok: false, problem: 'The answer must have "inputs" (a list of names), and "signals" and "outputs" (lists of objects with a "name" and a "formula").' };
  }
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return { ok: true, answer: { idea: text(data["idea"]).trim(), spec: { name: text(data["name"]), inputs: inputs as string[], signals, outputs } } };
}

function definitions(value: unknown): Definition[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: Definition[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry["name"] !== "string" || typeof entry["formula"] !== "string") return undefined;
    result.push({ name: entry["name"], formula: cleanFormula(entry["formula"]) });
  }
  return result;
}

/**
 * A model sometimes runs on past the end of a formula, into the brackets that close the JSON
 * ("... : I0)}]}"). Nothing that can be in a formula looks like that, so the formula ends before it.
 */
function cleanFormula(text: string): string {
  return (text.split(/[{}[\]"`;\\]/, 1)[0] ?? "").trim();
}

/** A spec written as the model writes it: compact JSON, for the examples and for the circuit to change. */
export function writeAnswer(idea: string, spec: CircuitSpec): string {
  return JSON.stringify({ idea, name: spec.name, inputs: spec.inputs, signals: spec.signals, outputs: spec.outputs });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
