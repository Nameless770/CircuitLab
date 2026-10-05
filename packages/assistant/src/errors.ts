/** Why the assistant couldn't answer. */
export type AssistantErrorCode =
  /** Nothing answers at Ollama's address: it isn't running, or the address is wrong. */
  | "ollama-unreachable"
  /** The model chosen in Settings isn't installed in Ollama. */
  | "model-not-found"
  /** Ollama answered with an error of its own. */
  | "ollama-error"
  /** Ollama's answer isn't what its documentation promises (probably not Ollama at that address). */
  | "bad-reply"
  /** The model took too long. */
  | "timeout"
  /** The person pressed Cancel. */
  | "cancelled"
  /** The request itself can't be used: it's empty, or too long for the model. */
  | "invalid-request";

/**
 * Something outside the model's control went wrong. `message` is written for the person using the
 * app and is shown as it is. A model that answers badly is not an error: that's a normal outcome
 * (see `designCircuit`).
 */
export class AssistantError extends Error {
  readonly code: AssistantErrorCode;

  constructor(code: AssistantErrorCode, message: string) {
    super(message);
    this.name = "AssistantError";
    this.code = code;
  }
}
