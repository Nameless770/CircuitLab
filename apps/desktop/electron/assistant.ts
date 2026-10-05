import { AssistantError, designCircuit, listModels, type LanguageModel } from "@circuitlab/assistant";
import { parseNetlist } from "@circuitlab/netlist";
import type { AssistantAnswer, AssistantModel, AssistantProgress, AssistantRequest, AssistantStatus } from "./bridge";
import { isLocalAddress } from "./helpers";
import { readNetlist, truthTablePage } from "./offline";

/**
 * The assistant, in the main process: asks Ollama for a circuit (the work is in
 * @circuitlab/assistant) and prepares what the window shows. No Electron imports, so it is unit
 * tested like offline.ts (test/assistant.test.ts).
 *
 * Why the main process and not the window? The window may only talk to its own origin (and has
 * no Node.js); Ollama is another address. The main process is also where settings live.
 */

/** A netlist longer than this isn't read: the assistant only changes small circuits, and parsing a huge text would freeze the app. */
export const MAX_NETLIST_CHARS = 200_000;
/** The preview shows the whole truth table up to this many inputs: 2 to that power rows. */
export const PREVIEW_INPUTS = 4;

/** Which installed model to use: the one chosen in Settings, if it's there, else the first (the newest). */
export function chooseModel(installed: readonly string[], saved: string | null): { readonly model: string | null; readonly problem?: string } {
  const first = installed[0];
  if (first === undefined) return { model: null, problem: "Ollama has no models yet. Download one with “ollama pull llama3.2” in a terminal, then try again." };
  if (saved === null || installed.includes(saved)) return { model: saved ?? first };
  return { model: first, problem: `The model “${saved}” isn't installed in Ollama any more, so “${first}” is used. Choose a model in Settings.` };
}

/** What Settings and the assistant's panel show about Ollama. */
export async function checkAssistant(url: string, savedModel: string | null, signal?: AbortSignal): Promise<AssistantStatus> {
  const local = isLocalAddress(url);
  try {
    const installed = await listModels(url, signal);
    const models: AssistantModel[] = installed.map((model) => ({
      name: model.name,
      ...(model.parameterSize !== undefined && { parameterSize: model.parameterSize }),
      sizeGigabytes: Math.round((model.sizeBytes / 1024 ** 3) * 10) / 10,
    }));
    const chosen = chooseModel(models.map((model) => model.name), savedModel);
    return { url, local, models, model: chosen.model, ...(chosen.problem !== undefined && { problem: chosen.problem }) };
  } catch (error) {
    if (!(error instanceof AssistantError)) throw error;
    return { url, local, models: [], model: null, problem: error.message };
  }
}

export interface AskHooks {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: AssistantProgress) => void;
}

/**
 * Asks `model` for a circuit and prepares the answer: the checked netlist, the circuit as the
 * window shows it, and the truth table of a small one, so it can be judged before it is used.
 * @throws AssistantError (Ollama isn't reachable, the request can't be used), NetlistError for a netlist to change that has mistakes, RangeError for one that is too long
 */
export async function askAssistant(model: LanguageModel, request: AssistantRequest, hooks: AskHooks = {}): Promise<AssistantAnswer> {
  if (request.netlist !== undefined && request.netlist.length > MAX_NETLIST_CHARS) {
    throw new RangeError(`This netlist is ${request.netlist.length.toLocaleString("en")} characters long; the assistant changes netlists of up to ${MAX_NETLIST_CHARS.toLocaleString("en")}. Ask it for a new circuit instead.`);
  }
  const current = request.netlist === undefined ? undefined : parseNetlist(request.netlist);
  const design = await designCircuit(
    model,
    { request: request.request, ...(current !== undefined && { current }) },
    {
      ...(hooks.signal !== undefined && { signal: hooks.signal }),
      onAttempt: (info) => hooks.onProgress?.({ attempt: info.attempt, of: info.of, problems: info.problems.length }),
    },
  );
  if (!design.ok) {
    return design.reason === "declined" ? { kind: "declined", message: design.message } : { kind: "invalid", attempts: design.attempts, problems: design.problems };
  }
  const circuit = readNetlist(design.netlist, "Assistant circuit");
  const small = circuit.summary.feedbackLoop === null && circuit.summary.inputs.length <= PREVIEW_INPUTS;
  return {
    kind: "circuit",
    model: model.name,
    attempts: design.attempts,
    idea: design.idea,
    netlist: design.netlist,
    circuit,
    table: small ? truthTablePage(circuit, 0, 2 ** PREVIEW_INPUTS) : null,
  };
}
