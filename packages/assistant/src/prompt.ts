import { recipesFor } from "./cookbook";
import type { ChatMessage } from "./ollama";
import { writeAnswer } from "./spec";

/**
 * What the model is told. It was tuned by measuring (docs/assistant.md): a small model follows
 * a short format with worked examples far better than a long list of rules, and too many
 * examples make it copy their details. So: a few rules, and the recipes most like the request.
 */

const INSTRUCTIONS = `You turn requests for digital logic circuits into a short description. Answer with one JSON object and nothing else.

{"idea": "one sentence on how the circuit works", "name": "short circuit name", "inputs": ["A", "B"], "signals": [], "outputs": [{"name": "Y", "formula": "A & B"}]}

Each output has a formula over the input names. Every input is 0 or 1. A formula can use:
- & (and), | (or), ^ (xor), ! (not) and parentheses
- arithmetic + - * / % and comparisons == != < <= > >=, which give 1 for true and 0 for false
- a ? b : c, which is b when a is 1 and c when a is 0
- the gates as functions: AND(A, B), OR, NAND, NOR, XOR, XNOR (two or more inputs) and NOT(A)
A count is easy with arithmetic: "at least two of A, B and C" is A + B + C >= 2.

Rules:
- Use the input and output names the user asks for. Names have letters, digits and _ only.
- "signals" stay empty, except for circuits that remember something (latches), where gates feed each other in a loop. A signal has a name and a formula, and formulas can use it by name.
- If the request is not about a digital circuit, or can't be made this way, leave "outputs" empty and say why in "idea".`;

/** The instructions, and the recipes that look most like this request. */
export function systemPrompt(request: string): ChatMessage {
  const examples = recipesFor(request).map((recipe) => `Request: ${recipe.request}\n${writeAnswer(recipe.idea, recipe.spec)}`);
  return { role: "system", content: `${INSTRUCTIONS}\n\nExamples:\n\n${examples.join("\n\n")}` };
}

/**
 * The request itself. `current` is the circuit to change, already written in the model's own
 * format (see describeCircuit): it is changed in the same words it will answer in.
 */
export function requestMessage(request: string, current?: string): ChatMessage {
  if (current === undefined) return { role: "user", content: `Design this circuit: ${request}` };
  return { role: "user", content: `Here is the current circuit:\n${current}\nChange it like this: ${request}\nAnswer with the complete new circuit.` };
}

/** Sent back with the model's own answer, when the circuit couldn't be built from it. */
export function repairMessage(problems: readonly string[]): ChatMessage {
  return { role: "user", content: `That can't be used, because:\n${problems.map((problem) => `- ${problem}`).join("\n")}\nAnswer with the corrected circuit, in the same format.` };
}
