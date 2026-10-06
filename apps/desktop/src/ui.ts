import { ApiError, NetworkError } from "./api";
import { SettingError } from "../electron/helpers";
import { LocalError } from "./desktop";
import { h } from "./dom";

/** Something the person needs to do or know ("Give the circuit a name first."), shown as it is. */
export class Notice extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Notice";
  }
}

/**
 * Where the API's own message (`detail`) would be confusing in the app, we say it our way.
 * Everything else shows the API's message, which is already written for people.
 */
const FRIENDLY_MESSAGES: Record<string, string> = {
  "invalid-token": "Your sign-in has expired. Please sign in again.",
  "unauthenticated": "Please sign in to do that.",
  "forbidden": "You can look at this circuit, but not change it. “Save a copy to the library” keeps your changes.",
  "not-found": "This circuit doesn't exist, or it isn't shared with you.",
  "precondition-failed":
    "Someone changed this circuit after you opened it. Close it and open it again to get the latest version (your unsaved changes here will be lost).",
  "server-busy": "The simulator is busy right now. Try again in a moment.",
};

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return FRIENDLY_MESSAGES[error.code] ?? error.message;
  if (error instanceof NetworkError || error instanceof LocalError || error instanceof SettingError || error instanceof Notice) return error.message;
  return `Something went wrong: ${error instanceof Error ? error.message : String(error)}`;
}

/** One problem in a list, from the API (ProblemIssue) or from offline mode (LocalIssue). */
export interface IssueLike {
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  readonly gateId?: string;
  readonly pointer?: string;
  readonly parameter?: string;
}

/** The details behind an error: every problem found, and the loop for `feedback-loop`. */
export function errorDetails(error: unknown): { issues: readonly IssueLike[]; cycle: readonly string[] } {
  const problem = error instanceof ApiError ? error.problem : error instanceof LocalError ? error.problem : null;
  return { issues: problem?.issues ?? [], cycle: problem?.cycle ?? [] };
}

/** A red box with the message and, for validation errors, every problem found. */
export function errorBox(error: unknown): HTMLElement {
  const box = h("div", { class: "alert error", role: "alert" }, h("strong", {}, errorMessage(error)));
  const { issues, cycle } = errorDetails(error);
  if (cycle.length > 0) box.append(h("p", {}, `The loop: ${cycle.join(" → ")}`));
  if (issues.length > 0) box.append(h("ul", {}, issues.map((issue) => h("li", {}, describeIssue(issue)))));
  return box;
}

export function describeIssue(issue: IssueLike): string {
  const where = issueLocation(issue);
  return where === "" ? issue.message : `${where}: ${issue.message}`;
}

function issueLocation(issue: IssueLike): string {
  if (issue.line !== undefined) return `Line ${issue.line}${issue.column === undefined ? "" : `, column ${issue.column}`}`;
  if (issue.gateId !== undefined) return `Gate "${issue.gateId}"`;
  if (issue.pointer !== undefined && issue.pointer !== "") return issue.pointer.slice(1).replaceAll("/", " › ");
  if (issue.parameter !== undefined) return issue.parameter;
  return "";
}

export function successBox(message: string): HTMLElement {
  return h("div", { class: "alert ok", role: "status" }, message);
}

export function loading(text = "Loading…"): HTMLElement {
  return h("p", { class: "loading" }, text);
}

/**
 * Runs an async action while its button is disabled, so a double click can't send the request
 * twice. Errors are shown in `messageArea` instead of being thrown.
 */
export async function runAction(button: HTMLButtonElement, messageArea: HTMLElement, action: () => Promise<void>): Promise<void> {
  button.disabled = true;
  messageArea.replaceChildren();
  try {
    await action();
  } catch (error) {
    messageArea.replaceChildren(errorBox(error));
  } finally {
    button.disabled = false;
  }
}

/** A labelled form field. */
export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), input, hint === undefined ? null : h("span", { class: "field-hint" }, hint));
}

/** A keyboard key, as the design draws it. */
export function kbd(text: string, extra = ""): HTMLElement {
  return h("span", { class: `kbd ${extra}`.trim() }, text);
}

/** A button: h("button") with the app's classes. */
export function button(label: string | Node, onClick: (event: MouseEvent) => void, options: { readonly class?: string; readonly title?: string; readonly type?: "button" | "submit" } = {}): HTMLButtonElement {
  const element = h("button", { type: options.type ?? "button", class: options.class ?? "btn", title: options.title ?? null }, label);
  element.addEventListener("click", onClick);
  return element;
}
