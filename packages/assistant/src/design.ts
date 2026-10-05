import type { Circuit } from "@circuitlab/engine";
import { buildCircuit } from "./build";
import { requestProblems } from "./checks";
import { describeCircuit } from "./describe";
import { AssistantError } from "./errors";
import type { ChatMessage, LanguageModel } from "./ollama";
import { repairMessage, requestMessage, systemPrompt } from "./prompt";
import { SPEC_SCHEMA, readAnswer, writeAnswer } from "./spec";

/** Longest request accepted, in characters. A circuit is described in a sentence or two. */
export const MAX_REQUEST_CHARS = 1_000;
/** How many times the model may answer before giving up: the first, and two repairs. */
export const DEFAULT_ATTEMPTS = 3;

export interface DesignRequest {
  /** What the person wants, in their own words. */
  readonly request: string;
  /** The circuit to change. Without it, the request is for a new circuit. */
  readonly current?: Circuit;
}

export interface AttemptInfo {
  /** 1 for the first answer. */
  readonly attempt: number;
  readonly of: number;
  /** What was wrong with the answer before, sent back to the model: empty for the first attempt. */
  readonly problems: readonly string[];
}

export interface DesignOptions {
  /** How many answers to try for. Default `DEFAULT_ATTEMPTS`. */
  readonly attempts?: number;
  /** Stops the work: designCircuit rejects with the code "cancelled". */
  readonly signal?: AbortSignal;
  /** Called before each question to the model, so a screen can say what's going on. */
  readonly onAttempt?: (info: AttemptInfo) => void;
}

/**
 * How it ended. A model that can't do it is a normal ending, not an error: the person is told,
 * and can ask again another way.
 */
export type Design =
  | {
      readonly ok: true;
      /** The netlist, checked: it reads back as `circuit`. */
      readonly netlist: string;
      readonly circuit: Circuit;
      /** The model's own sentence on how it works. */
      readonly idea: string;
      readonly attempts: number;
    }
  /** The model said it can't make this (it isn't a circuit, or isn't something formulas can say). */
  | { readonly ok: false; readonly reason: "declined"; readonly message: string; readonly attempts: number }
  /** Every answer had problems; these are the last answer's. */
  | { readonly ok: false; readonly reason: "invalid"; readonly problems: readonly string[]; readonly attempts: number };

/**
 * Asks the model for a circuit, and checks the answer before anyone sees it. The model writes a
 * name and a formula for each output; `buildCircuit` makes the gates and wires them; anything
 * it can't make, it describes in words, and the model is asked again with that description,
 * a few times. Nothing the model writes reaches the person unless it became a valid circuit.
 *
 * @throws AssistantError when the request can't be used, or Ollama can't be reached or is stopped
 */
export async function designCircuit(model: LanguageModel, input: DesignRequest, options: DesignOptions = {}): Promise<Design> {
  const request = input.request.trim();
  if (request === "") throw new AssistantError("invalid-request", "Write what circuit you want first.");
  if (request.length > MAX_REQUEST_CHARS) {
    throw new AssistantError("invalid-request", `That request is ${request.length} characters long; the most is ${MAX_REQUEST_CHARS}. Describe the circuit more briefly.`);
  }

  let current: string | undefined;
  if (input.current !== undefined) {
    const described = describeCircuit(input.current);
    if (!described.ok) throw new AssistantError("invalid-request", described.reason);
    current = writeAnswer("The circuit as it is now.", described.spec);
  }

  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const start: ChatMessage[] = [systemPrompt(request), requestMessage(request, current)];
  let messages = start;
  let problems: readonly string[] = [];

  for (let attempt = 1; ; attempt++) {
    options.onAttempt?.({ attempt, of: attempts, problems });
    const reply = await model.chat(messages, { format: SPEC_SCHEMA, ...(options.signal !== undefined && { signal: options.signal }) });

    const read = readAnswer(reply);
    if (read.ok) {
      const { idea, spec } = read.answer;
      if (spec.outputs.length === 0) {
        return { ok: false, reason: "declined", message: idea === "" ? "The assistant couldn't make a circuit from that." : idea, attempts: attempt };
      }
      const built = buildCircuit(spec);
      if (built.ok) {
        // A circuit can be valid and still not be what was asked for: the checks that don't need to know what it computes.
        problems = requestProblems(request, built.circuit);
        if (problems.length === 0) return { ok: true, netlist: built.netlist, circuit: built.circuit, idea, attempts: attempt };
      } else {
        problems = built.problems;
      }
    } else {
      problems = [read.problem];
    }

    if (attempt >= attempts) return { ok: false, reason: "invalid", problems, attempts: attempt };
    // Only the latest answer and what was wrong with it go back: a longer conversation fills up
    // the model's memory, and an old mistake doesn't help to fix a new one.
    messages = [...start, { role: "assistant", content: reply }, repairMessage(problems)];
  }
}
