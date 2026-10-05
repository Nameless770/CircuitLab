import type { AssistantAnswer, AssistantProgress, AssistantStatus, DesktopBridge } from "../../electron/bridge";
import { renderTruthTable } from "../circuit/truth-table";
import { LocalError, desktop, unwrap } from "../desktop";
import { appendAll, h, plural } from "../dom";
import { errorBox } from "../ui";

/**
 * The assistant, as a panel in the netlist editor: describe a circuit in words, and a language
 * model running in Ollama on this computer drafts it. What it drafts is only ever a draft:
 * the app checks it (the main process builds the netlist and reads it back), shows how it behaves,
 * and puts it in the editor only when the person says so. See docs/assistant.md.
 */

export interface AssistantPanelOptions {
  /** The netlist in the editor right now. */
  currentText(): string;
  /** Puts new text in the editor, the way typing would. */
  replaceText(text: string): void;
  /** The editor holds nothing yet but what a new netlist starts with, so the request is for a new circuit. */
  startsEmpty: boolean;
  /** Put the cursor in the request box. */
  focus: boolean;
}

/** Things to try: they fill the request box. */
const EXAMPLE_REQUESTS = ["a full adder", "a 2-to-1 multiplexer with inputs D0, D1 and SEL", "a circuit that is 1 when at least two of A, B and C are 1", "an SR latch from NOR gates"];

/** Longest request: the same as the assistant's own limit (MAX_REQUEST_CHARS in @circuitlab/assistant). */
const MAX_REQUEST_CHARS = 1_000;

// The main process sends progress for whichever question is being worked on. The bridge can't
// take a listener away again, so there is one listener, which passes progress to the panel asking.
let progressListener: ((progress: AssistantProgress) => void) | null = null;
let listening = false;
function listenForProgress(bridge: DesktopBridge): void {
  if (listening) return;
  listening = true;
  bridge.onAssistantProgress((progress) => progressListener?.(progress));
}

/** The panel, or null in a browser tab: the assistant is part of the desktop app (it talks to Ollama from there). */
export function assistantPanel(options: AssistantPanelOptions): HTMLElement | null {
  const maybeBridge = desktop();
  if (maybeBridge === null) return null;
  // A non-null copy: TypeScript forgets the check above inside the functions declared below.
  const bridge: DesktopBridge = maybeBridge;
  listenForProgress(bridge);

  const request = h("textarea", {
    rows: "3",
    maxlength: String(MAX_REQUEST_CHARS),
    "aria-label": "What circuit do you want?",
    placeholder: "Describe a circuit, or a change to this one. For example: a 2-to-1 multiplexer with inputs D0, D1 and SEL",
  });
  const newCircuit = h("input", { type: "radio", name: "assistant-mode", checked: options.startsEmpty });
  const changeCircuit = h("input", { type: "radio", name: "assistant-mode", checked: !options.startsEmpty });
  const ask = h("button", { type: "button", class: "primary" }, "Ask");
  const stop = h("button", { type: "button", hidden: true }, "Cancel");
  const status = h("p", { class: "muted small assistant-status" }, "Looking for Ollama…");
  const working = h("div");
  const messages = h("div");
  const draft = h("div");
  let model: string | null = null;

  function showStatus(found: AssistantStatus): void {
    model = found.model;
    if (found.model === null) {
      status.replaceChildren(h("span", { class: "problem" }, found.problem ?? "Ollama isn't available."), " ", recheck());
      return;
    }
    const where = found.local ? "on this computer: what you write here doesn't leave it." : `at ${found.url}, which is not this computer: what you write here is sent there.`;
    status.replaceChildren(`Using ${found.model} in Ollama, ${where}`, ...(found.problem === undefined ? [] : [h("span", { class: "problem" }, ` ${found.problem}`)]));
  }

  function recheck(): HTMLElement {
    const button = h("button", { type: "button", class: "link-button" }, "Check again");
    button.addEventListener("click", () => void checkOllama());
    return button;
  }

  async function checkOllama(): Promise<void> {
    status.replaceChildren("Looking for Ollama…");
    showStatus(await bridge.assistantStatus());
  }

  async function submit(): Promise<void> {
    const wanted = request.value.trim();
    messages.replaceChildren();
    if (wanted === "") {
      messages.append(h("p", { class: "alert alert-warning" }, "Write what circuit you want first."));
      request.focus();
      return;
    }
    // "Change" needs something to change.
    const changing = changeCircuit.checked && options.currentText().trim() !== "";

    ask.disabled = true;
    stop.hidden = false;
    draft.replaceChildren();
    const started = Date.now();
    let progress: AssistantProgress | null = null;
    const showWorking = (): void => {
      const seconds = Math.round((Date.now() - started) / 1000);
      const attempt = progress === null || progress.attempt === 1 ? "" : ` Attempt ${progress.attempt} of ${progress.of}: fixing ${plural(progress.problems, "problem")}.`;
      working.replaceChildren(h("p", { class: "muted loading" }, `Asking ${model ?? "the model"}… ${seconds} s.${attempt}`));
    };
    showWorking();
    const timer = setInterval(showWorking, 1000);
    progressListener = (next) => {
      progress = next;
      showWorking();
    };

    try {
      const answer = unwrap(await bridge.askAssistant({ request: wanted, ...(changing && { netlist: options.currentText() }) }));
      showAnswer(answer);
    } catch (error) {
      // Cancel is not a failure.
      if (error instanceof LocalError && error.problem.code === "cancelled") messages.append(h("p", { class: "alert alert-info" }, "Stopped."));
      else messages.append(errorBox(error));
      void checkOllama(); // the likeliest reason for an error is that Ollama went away: show how it looks now
    } finally {
      clearInterval(timer);
      progressListener = null;
      working.replaceChildren();
      ask.disabled = false;
      stop.hidden = true;
    }
  }

  function showAnswer(answer: AssistantAnswer): void {
    if (answer.kind === "declined") {
      messages.append(h("div", { class: "alert alert-info" }, h("strong", {}, "The assistant can't make that. "), answer.message));
      return;
    }
    if (answer.kind === "invalid") {
      messages.append(
        h(
          "div",
          { class: "alert alert-error", role: "alert" },
          h("strong", {}, `The assistant tried ${answer.attempts} times and couldn't make a circuit that works.`),
          h("ul", { class: "issues" }, answer.problems.map((problem) => h("li", {}, problem))),
          h("p", {}, "Try asking another way, or pick a bigger model in Settings."),
        ),
      );
      return;
    }

    const { circuit } = answer;
    const inputs = circuit.summary.inputs.length === 0 ? "no inputs" : `inputs ${circuit.summary.inputs.join(", ")}`;
    const outputs = circuit.summary.outputs.length === 0 ? "no outputs" : `outputs ${circuit.summary.outputs.join(", ")}`;
    const behaviour =
      answer.table !== null
        ? renderTruthTable(answer.table)
        : circuit.summary.feedbackLoop !== null
          ? h("p", { class: "muted" }, "It has a feedback loop, so it remembers and has no truth table. After you save it, step through it with “Try it”.")
          : h("p", { class: "muted" }, "It has too many inputs to show its whole truth table here. After you save it, the circuit's page has it.");

    const use = h("button", { type: "button", class: "primary" }, "Use this in the editor");
    use.addEventListener("click", () => {
      const before = options.currentText();
      options.replaceText(answer.netlist);
      const undo = h("button", { type: "button" }, "Undo");
      undo.addEventListener("click", () => {
        options.replaceText(before);
        draft.replaceChildren();
      });
      draft.replaceChildren(h("div", { class: "alert alert-success", role: "status" }, "The editor now holds the assistant's circuit. Press Check, then save it. ", undo));
    });
    const discard = h("button", { type: "button" }, "Discard");
    discard.addEventListener("click", () => draft.replaceChildren());

    draft.replaceChildren(
      h(
        "section",
        { class: "draft" },
        h("h3", {}, answer.circuit.name),
        answer.idea === "" ? null : h("p", {}, answer.idea),
        h("p", { class: "muted" }, `${plural(circuit.gates.length, "gate")}, ${inputs} → ${outputs}.`),
        behaviour,
        h("details", {}, h("summary", {}, "The netlist"), h("pre", { class: "netlist-text" }, answer.netlist)),
        h(
          "p",
          { class: "muted small" },
          `Made by ${answer.model}${answer.attempts > 1 ? ` after ${answer.attempts} tries` : ""}. A small model can be wrong: look at the truth table before you trust the circuit.`,
        ),
        h("div", { class: "button-row" }, use, discard),
      ),
    );
  }

  ask.addEventListener("click", () => void submit());
  stop.addEventListener("click", () => void bridge.cancelAssistant());
  request.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  });

  const examples = EXAMPLE_REQUESTS.map((text) => {
    const button = h("button", { type: "button", class: "link-button" }, text);
    button.addEventListener("click", () => {
      request.value = text;
      request.focus();
    });
    return button;
  });

  const panel = h("section", { class: "card assistant" });
  appendAll(
    panel,
    h("h2", {}, "Ask the assistant"),
    h("p", { class: "muted" }, "Describe the circuit in words. A language model running on this computer (Ollama) drafts it, and you check it before it goes in the editor."),
    request,
    h(
      "div",
      { class: "assistant-actions" },
      h("label", { class: "inline-choice" }, newCircuit, " A new circuit"),
      h("label", { class: "inline-choice" }, changeCircuit, " Change the netlist below"),
      ask,
      stop,
    ),
    h("div", { class: "assistant-examples" }, h("span", { class: "muted small" }, "Try: "), examples),
    status,
    working,
    messages,
    draft,
  );
  if (options.focus) request.focus();
  void checkOllama();
  return panel;
}
