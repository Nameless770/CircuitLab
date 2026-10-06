import type { AssistantAnswer, AssistantProgress, DesktopBridge } from "../../electron/bridge";
import { renderTruthTable } from "../circuit/truth-table";
import { LocalError, desktop, unwrap } from "../desktop";
import { thumbnail } from "../diagram/thumb";
import { h, plural } from "../dom";
import type { Draft } from "../editor/draft";
import { on } from "../shell/bus";
import { goTo } from "../shell/commands";
import { assistantState, checkAssistant } from "../shell/status";
import { toast } from "../shell/toast";
import { errorBox } from "../ui";
import { startingText } from "../workspace/netlist-stage";
import { applyNetlist, currentDoc, docChanged, openUnsavedText, syncInputs, type OpenDoc } from "../workspace/store";

/**
 * The assistant, as a panel that slides in from the right over any screen: describe a circuit in
 * words, and a language model running in Ollama on this computer drafts it. What it drafts is only
 * ever a draft: the app checks it (the main process builds the netlist and reads it back), shows
 * how it behaves, and puts it in the workspace only when the person says so. See docs/assistant.md.
 */

/** Things to try: they fill the request box. */
const EXAMPLE_REQUESTS = ["a full adder", "a 2-to-1 multiplexer with inputs D0, D1 and SEL", "a circuit that is 1 when at least two of A, B and C are 1", "an SR latch from NOR gates"];

/** Longest request: the same as the assistant's own limit (MAX_REQUEST_CHARS in @circuitlab/assistant). */
const MAX_REQUEST_CHARS = 1_000;

type AskMode = "new" | "change";

/** The panel stays in memory while closed, so what was typed and drafted is still there next time. */
let panel: { readonly element: HTMLElement; setMode(mode: AskMode): void; focus(): void; redraw(): void } | null = null;
let isOpen = false;

export function assistantIsOpen(): boolean {
  return isOpen;
}

/** Opens the panel; `mode` chooses between a new circuit and a change to the open one. */
export function openAssistant(mode?: AskMode): void {
  const bridge = desktop();
  if (bridge === null) {
    toast("The assistant is part of the desktop app.", { error: true });
    return;
  }
  panel ??= makePanel(bridge);
  if (mode !== undefined) panel.setMode(mode);
  panel.redraw();
  if (!isOpen) {
    (document.getElementById("overlays") ?? document.body).append(panel.element);
    isOpen = true;
    void checkAssistant(); // Ollama may have started (or stopped) since
  }
  panel.focus();
}

export function closeAssistant(): void {
  panel?.element.remove();
  isOpen = false;
}

// The main process sends progress for whichever question is being worked on. The bridge can't take
// a listener away again, so there is one listener, which passes progress to the panel asking.
let progressListener: ((progress: AssistantProgress) => void) | null = null;
let listening = false;

function makePanel(bridge: DesktopBridge): NonNullable<typeof panel> {
  if (!listening) {
    listening = true;
    bridge.onAssistantProgress((progress) => progressListener?.(progress));
  }
  let mode: AskMode = currentDoc() === null ? "new" : "change";
  let working = false;

  const request = h("textarea", {
    class: "as-request",
    rows: "3",
    maxlength: String(MAX_REQUEST_CHARS),
    "aria-label": "What circuit do you want?",
    placeholder: "Describe a circuit, or a change to this one. For example: a 2-to-1 multiplexer with inputs D0, D1 and SEL",
  });
  const modes = h("div", { class: "seg sm", role: "group", "aria-label": "What to ask for" });
  const cancel = h("button", { type: "button", class: "btn lg", hidden: true }, "Cancel");
  const ask = h("button", { type: "button", class: "btn lg primary", title: "Ctrl Enter" }, "Ask");
  const status = h("div", { class: "as-note" });
  const warning = h("div");
  const progress = h("div");
  const answerArea = h("div");

  function drawModes(): void {
    // An empty circuit has nothing to change: its answer goes into it as a new circuit (see useAnswer).
    const hasDoc = (currentDoc()?.draft.gates.length ?? 0) > 0;
    if (!hasDoc) mode = "new";
    modes.replaceChildren(
      ...(
        [
          ["new", "A new circuit"],
          ["change", "Change the open circuit"],
        ] as const
      ).map(([value, label]) => {
        const button = h("button", { type: "button", "aria-pressed": mode === value ? "true" : "false", disabled: value === "change" && !hasDoc, title: value === "change" && !hasDoc ? "Open a circuit first" : null }, label);
        button.addEventListener("click", () => {
          mode = value;
          drawModes();
        });
        return button;
      }),
    );
  }

  function drawStatus(): void {
    const found = assistantState();
    if (found === null) {
      status.replaceChildren(h("span", { class: "led small" }), h("span", {}, "Looking for Ollama…"));
      return;
    }
    if (found.model === null) {
      const again = h("button", { type: "button", class: "link-btn" }, "Check again");
      again.addEventListener("click", () => void checkAssistant());
      status.replaceChildren(h("span", { class: "led small bad" }), h("span", {}, h("span", { class: "problem" }, found.problem ?? "Ollama isn't available."), " ", again));
      return;
    }
    const where = found.local ? "on this computer: what you write here doesn't leave it." : `at ${found.url}, which is not this computer: what you write here is sent there.`;
    status.replaceChildren(
      h("span", { class: "led small ok" }),
      h("span", {}, `Using ${found.model} in Ollama, ${where}`, found.problem === undefined ? null : h("span", { class: "problem" }, ` ${found.problem}`)),
    );
  }
  on("status", drawStatus);

  async function submit(): Promise<void> {
    if (working) return;
    const wanted = request.value.trim();
    warning.replaceChildren();
    if (wanted === "") {
      warning.append(h("div", { class: "alert warn" }, "Write what circuit you want first."));
      request.focus();
      return;
    }
    const doc = currentDoc();
    const changing = mode === "change" && doc !== null;
    working = true;
    ask.disabled = true;
    cancel.hidden = false;
    answerArea.replaceChildren();
    const started = Date.now();
    const model = assistantState()?.model ?? "the model";
    let latest: AssistantProgress | null = null;
    const showWorking = (): void => {
      const seconds = Math.round((Date.now() - started) / 1000);
      const attempt = latest === null || latest.attempt === 1 ? "" : ` Attempt ${latest.attempt} of ${latest.of}: fixing ${plural(latest.problems, "problem")}.`;
      progress.replaceChildren(h("div", { class: "as-working", role: "status" }, h("span", {}, `Asking ${model}… ${seconds} s.${attempt}`), h("div", { class: "bar" }, h("div"))));
    };
    showWorking();
    const timer = setInterval(showWorking, 1000);
    progressListener = (next) => {
      latest = next;
      showWorking();
    };
    try {
      const answer = unwrap(await bridge.askAssistant({ request: wanted, ...(changing && { netlist: changeText(doc) }) }));
      showAnswer(answer, changing ? doc : null);
    } catch (error) {
      // Cancel is not a failure.
      if (error instanceof LocalError && error.problem.code === "cancelled") warning.append(h("div", { class: "alert warn" }, "Stopped."));
      else warning.append(errorBox(error));
      void checkAssistant(); // the likeliest reason for an error is that Ollama went away: show how it looks now
    } finally {
      clearInterval(timer);
      progressListener = null;
      progress.replaceChildren();
      working = false;
      ask.disabled = false;
      cancel.hidden = true;
    }
  }

  function showAnswer(answer: AssistantAnswer, target: OpenDoc | null): void {
    if (answer.kind === "declined") {
      warning.append(h("div", { class: "alert warn" }, h("strong", {}, "The assistant can't make that. "), answer.message));
      return;
    }
    if (answer.kind === "invalid") {
      warning.append(
        h(
          "div",
          { class: "alert error", role: "alert" },
          h("strong", {}, `The assistant tried ${answer.attempts} times and couldn't make a circuit that works.`),
          h("ul", {}, answer.problems.map((problem) => h("li", {}, problem))),
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
        ? h("div", { class: "as-table" }, renderTruthTable(answer.table))
        : circuit.summary.feedbackLoop !== null
          ? h("p", { class: "muted" }, "It has a feedback loop, so it remembers and has no truth table. In the workspace, step through it in Simulate.")
          : h("p", { class: "muted" }, "It has too many inputs to show its whole truth table here. The workspace has it.");

    const use = h("button", { type: "button", class: "btn lg primary" }, target === null ? "Use this in the editor" : "Use this in the open circuit");
    use.addEventListener("click", () => void useAnswer(answer.netlist, answer.idea, target));
    const discard = h("button", { type: "button", class: "btn lg" }, "Discard");
    discard.addEventListener("click", () => answerArea.replaceChildren());

    answerArea.replaceChildren(
      h(
        "section",
        { class: "as-answer" },
        h("h3", {}, circuit.name),
        answer.idea === "" ? null : h("p", {}, answer.idea),
        h("span", { class: "mono muted small" }, `${plural(circuit.gates.length, "gate")}, ${inputs} → ${outputs}.`),
        h("div", { class: "as-thumb" }, thumbnail(circuit)),
        behaviour,
        h("details", {}, h("summary", {}, "The netlist"), h("pre", { class: "netlist-text" }, answer.netlist)),
        h(
          "p",
          { class: "muted small" },
          `Made by ${answer.model}${answer.attempts > 1 ? ` after ${answer.attempts} tries` : ""}. A small model can be wrong: look at the truth table before you trust the circuit.`,
        ),
        h("div", { class: "as-row" }, use, discard),
      ),
    );
  }

  async function useAnswer(netlist: string, idea: string, target: OpenDoc | null): Promise<void> {
    try {
      const open = currentDoc();
      if (target === null && open !== null && open.draft.gates.length === 0) {
        // A new, empty circuit takes the answer itself, so Save still puts it where that circuit
        // was going (your account, for a new circuit started from the server's lists).
        await applyNetlist(open, netlist);
        if (open.draft.description === "") open.draft.description = idea;
        open.mode = "sim";
        closeAssistant();
        goTo("/workspace");
        toast("The workspace now holds the assistant's circuit. Check it, then save it.");
        return;
      }
      if (target === null || target !== open) {
        if ((await openUnsavedText(netlist, idea)) === null) return; // the person kept the open circuit
        closeAssistant();
        goTo("/workspace");
        toast("The workspace now holds the assistant's circuit. Check it, then save it.");
        return;
      }
      // A change to the open circuit: it stays where it's saved, with unsaved changes, and can be undone.
      const before = snapshot(target);
      await applyNetlist(target, netlist);
      target.mode = "sim";
      closeAssistant();
      goTo("/workspace");
      toast("The assistant's change is in the open circuit. Check it, then save it.", {
        action: {
          label: "Undo",
          run: () => {
            restore(target, before);
            goTo("/workspace");
          },
        },
      });
    } catch (error) {
      warning.replaceChildren(errorBox(error));
    }
  }

  ask.addEventListener("click", () => void submit());
  cancel.addEventListener("click", () => void bridge.cancelAssistant());
  request.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void submit();
    }
  });
  const chips = EXAMPLE_REQUESTS.map((text) => {
    const chip = h("button", { type: "button", class: "chip" }, text);
    chip.addEventListener("click", () => {
      request.value = text;
      warning.replaceChildren();
      request.focus();
    });
    return chip;
  });

  const close = h("button", { type: "button", class: "as-close", title: "Close (Esc)" }, "Esc");
  close.addEventListener("click", closeAssistant);
  const element = h(
    "aside",
    { class: "assistant", "aria-label": "Ask the assistant" },
    h("div", { class: "as-head" }, h("h2", {}, "Ask the assistant"), close),
    h(
      "div",
      { class: "as-body" },
      h("p", { class: "muted" }, "Describe the circuit in words. A language model running on this computer (Ollama) drafts it, and you check it before it goes in the workspace."),
      request,
      h("div", { class: "as-row" }, modes, h("div", { class: "grow" }), cancel, ask),
      h("div", { class: "chips" }, h("span", { class: "muted small" }, "Try:"), chips),
      status,
      warning,
      progress,
      answerArea,
    ),
  );

  return {
    element,
    setMode(next) {
      mode = next;
    },
    focus() {
      request.focus();
    },
    redraw() {
      drawModes();
      drawStatus();
    },
  };
}

/** The open circuit's netlist, as the model is shown it: what the netlist editor holds, else the circuit. */
function changeText(doc: OpenDoc): string {
  return startingText(doc);
}

interface Snapshot {
  readonly draft: Draft;
  readonly text: string | null;
  readonly netText: string | null;
  readonly dirty: boolean;
}

function snapshot(doc: OpenDoc): Snapshot {
  const { draft } = doc;
  return {
    draft: { ...draft, gates: [...draft.gates], wires: [...draft.wires], pins: new Map(draft.pins), positions: new Map(draft.positions) },
    text: doc.text,
    netText: doc.netText,
    dirty: doc.dirty,
  };
}

function restore(doc: OpenDoc, before: Snapshot): void {
  doc.draft = before.draft;
  doc.text = before.text;
  doc.netText = before.netText;
  doc.dirty = before.dirty;
  doc.state = undefined;
  doc.steps = 0;
  syncInputs(doc);
  docChanged();
}
