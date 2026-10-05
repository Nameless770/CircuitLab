import { AssistantError } from "./errors";

/** Where Ollama listens when nothing was changed. */
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatOptions {
  /** A JSON schema. Ollama then only lets the model write text that fits it. */
  readonly format?: object;
  /** Stops the request: it rejects with the code "cancelled". */
  readonly signal?: AbortSignal;
}

/** Anything that can answer a conversation. Ollama is one; the tests use a scripted one. */
export interface LanguageModel {
  /** What the person sees, e.g. "llama3.2:3b". */
  readonly name: string;
  chat(messages: readonly ChatMessage[], options?: ChatOptions): Promise<string>;
}

export interface OllamaSettings {
  readonly model: string;
  /** Default: DEFAULT_OLLAMA_URL. No slash at the end. */
  readonly baseUrl?: string;
  /** Lower is steadier. Default 0.2: circuits should come out the same way twice. */
  readonly temperature?: number;
  /** A fixed seed makes a run repeatable. Left out in the app, used by the evaluation. */
  readonly seed?: number;
  /**
   * How much text the model can keep in mind, in tokens: the instructions, the circuit, and the
   * answer together. Default 8192. Ollama would otherwise pick its own size, and cuts off what
   * doesn't fit without saying so.
   */
  readonly contextTokens?: number;
  /** Longest answer, in tokens. Stops a model that never ends: a circuit is a few hundred tokens. Default 1024. */
  readonly maxReplyTokens?: number;
  /** How long to wait for one answer. Default 120 seconds: the first one also loads the model. */
  readonly timeoutMs?: number;
}

/** What Ollama reports about a downloaded model. */
export interface InstalledModel {
  /** The name to use, with its tag: "llama3.2:3b". */
  readonly name: string;
  readonly sizeBytes: number;
  /** "3.2B", when Ollama says. */
  readonly parameterSize: string | undefined;
}

/** Longest wait when only asking what's installed: that is quick, or Ollama isn't there. */
const LIST_TIMEOUT_MS = 5_000;

/** Talks to Ollama's HTTP API (https://github.com/ollama/ollama/blob/main/docs/api.md). */
export class OllamaClient implements LanguageModel {
  readonly name: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly seed: number | undefined;
  private readonly contextTokens: number;
  private readonly maxReplyTokens: number;
  private readonly timeoutMs: number;

  constructor(settings: OllamaSettings) {
    this.name = settings.model;
    this.baseUrl = settings.baseUrl ?? DEFAULT_OLLAMA_URL;
    this.temperature = settings.temperature ?? 0.2;
    this.seed = settings.seed;
    this.contextTokens = settings.contextTokens ?? 8192;
    this.maxReplyTokens = settings.maxReplyTokens ?? 1024;
    this.timeoutMs = settings.timeoutMs ?? 120_000;
  }

  /** @throws AssistantError */
  async chat(messages: readonly ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const body = {
      model: this.name,
      messages,
      stream: false, // one answer, when it's complete: every answer is checked as a whole anyway
      ...(options.format !== undefined && { format: options.format }),
      options: {
        temperature: this.temperature,
        num_ctx: this.contextTokens,
        num_predict: this.maxReplyTokens,
        ...(this.seed !== undefined && { seed: this.seed }),
      },
    };
    const reply = await send(this.baseUrl, "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, this.timeoutMs, options.signal);
    if (!reply.ok) {
      const detail = errorText(reply.body);
      // A 404 is also what any other web server says to an address it doesn't know, so look at the words.
      if (reply.status === 404 && /not found/i.test(detail)) {
        throw new AssistantError("model-not-found", `The model “${this.name}” isn't installed in Ollama. Pick another one in Settings.`);
      }
      throw new AssistantError("ollama-error", `Ollama answered with an error: ${detail}`);
    }
    const content = isRecord(reply.body) && isRecord(reply.body["message"]) ? reply.body["message"]["content"] : undefined;
    if (typeof content !== "string") throw notOllama(this.baseUrl);
    return content;
  }
}

/**
 * The models downloaded in Ollama, newest first.
 * @throws AssistantError "ollama-unreachable" when nothing answers
 */
export async function listModels(baseUrl: string = DEFAULT_OLLAMA_URL, signal?: AbortSignal): Promise<InstalledModel[]> {
  const reply = await send(baseUrl, "/api/tags", { method: "GET" }, LIST_TIMEOUT_MS, signal);
  const models = isRecord(reply.body) ? reply.body["models"] : undefined;
  if (!reply.ok || !Array.isArray(models)) throw notOllama(baseUrl);
  const result: InstalledModel[] = [];
  for (const entry of models) {
    if (!isRecord(entry) || typeof entry["name"] !== "string") continue;
    const details = entry["details"];
    const parameterSize = isRecord(details) && typeof details["parameter_size"] === "string" ? details["parameter_size"] : undefined;
    result.push({ name: entry["name"], sizeBytes: typeof entry["size"] === "number" ? entry["size"] : 0, parameterSize });
  }
  return result;
}

interface Reply {
  readonly ok: boolean;
  readonly status: number;
  /** The JSON Ollama sent, or undefined when it wasn't JSON. */
  readonly body: unknown;
}

/** One HTTP request to Ollama, with a time limit and the person's Cancel button. */
async function send(baseUrl: string, path: string, init: RequestInit, timeoutMs: number, signal: AbortSignal | undefined): Promise<Reply> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const stop = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    const response = await fetch(`${baseUrl}${path}`, { ...init, signal: stop });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined; // an HTML error page, say: the callers treat it as "not Ollama"
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    if (signal?.aborted === true) throw new AssistantError("cancelled", "Stopped.");
    if (timeout.aborted) {
      throw new AssistantError("timeout", `Ollama didn't answer within ${Math.round(timeoutMs / 1000)} seconds. The model may be too big for this computer.`);
    }
    // Node's fetch says only "fetch failed" when nothing is listening; the reason is in `cause`.
    throw new AssistantError("ollama-unreachable", `Can't reach Ollama at ${baseUrl}. Is it running? Start the Ollama app and try again.${causeOf(error)}`);
  }
}

function causeOf(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  const code = isRecord(cause) ? cause["code"] : undefined;
  return typeof code === "string" ? ` (${code})` : "";
}

function notOllama(baseUrl: string): AssistantError {
  return new AssistantError("bad-reply", `${baseUrl} answered, but not the way Ollama does. Check the address in Settings.`);
}

/** Ollama's errors look like {"error": "model \"x\" not found"}. */
function errorText(body: unknown): string {
  const text = isRecord(body) ? body["error"] : undefined;
  return typeof text === "string" && text !== "" ? text : "no details";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
