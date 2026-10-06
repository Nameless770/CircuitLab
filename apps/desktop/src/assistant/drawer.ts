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
 * The assistant: describe a circuit in words, and a language model running in Ollama on this
 * computer drafts it. What it drafts is only ever a draft: the app checks it (the main process
 * builds the netlist and reads it back), shows how it behaves, and puts it in the workspace only
 * when the person says so. See docs/assistant.md.
 *
 * It is one panel, shown in one of two places:
 * - in the workspace, in the right-hand column (the "Assistant" tab beside "Details"), so the
 *   circuit stays in view and you can keep drawing or simulating while you ask;
 * - on any other screen, sliding in over the screen from the right.
 */

/** Things to try: they fill the request box. */
const EXAMPLE_REQUESTS = ["a full adder", "a 2-to-1 multiplexer with inputs D0, D1 and SEL", "a circuit that is 1 when at least two of A, B and C are 1", "an SR latch from NOR gates"];

/** Longest request: the same as the assistant's own limit (MAX_REQUEST_CHARS in @circuitlab/assistant). */
const MAX_REQUEST_CHARS = 1_000;

type AskMode = "new" | "change";

/** Where the panel is: nowhere, over the screen, or in the workspace's right-hand column. */
type Placement = "closed" | "floating" | "docked";

/** The workspace's right-hand column, while the workspace is on screen. */
export interface AssistantDock {
  /** Puts the panel in the column, and shows it (the Assistant tab). */
  show(element: HTMLElement): void;
  /** The panel left the column: show the details again. */
  hide(): void;
}

/** The panel stays in memory while closed, so what was typed and drafted is still there next time. */
let panel: { readonly element: HTMLElement; setMode(mode: AskMode): void; focus(): void; redraw(): void } | null = null;
let placement: Placement = "closed";
let dock: AssistantDock | null = null;

/** True while the panel slides over the screen (Esc closes it then). */
export function assistantFloating(): boolean {
  return placement === "floating";
}

/** True while the keyboard is in the panel (the request box, its buttons). */
export function assistantHasFocus(): boolean {
  return panel !== null && placement !== "closed" && panel.element.contains(document.activeElement);
}

/**
 * Opens the panel: in the workspace's column if the workspace is on screen, else over the screen.
 * `mode` chooses between a new circuit and a change to the open one; beside a circuit it starts
 * on a change. `focus: false` leaves the keyboard where it is (the workspace opening it by itself).
 */
export function openAssistant(mode?: AskMode, { focus = true }: { readonly focus?: boolean } = {}): void {
  const bridge = desktop();
  if (bridge === null) {
    toast("The assistant is part of the desktop app.", { error: true });
    return;
  }
  panel ??= makePanel(bridge);
  const wasClosed = placement === "closed";
  if (dock !== null) {
    if (placement !== "docked") {
      panel.element.remove(); // it may have been over the screen
      panel.element.classList.add("docked");
      dock.show(panel.element);
      placement = "docked";
    }
  } else if (placement !== "floating") {
    panel.element.classList.remove("docked");
    (document.getElementById("overlays") ?? document.body).append(panel.element);
    placement = "floating";
  }
  if (mode !== undefined) panel.setMode(mode);
  else if (wasClosed && placement === "docked") panel.setMode("change"); // an empty circuit falls back to "new"
  panel.redraw();
  if (wasClosed) void checkAssistant(); // Ollama may have started (or stopped) since
  if (focus) panel.focus();
}

export function closeAssistant(): void {
  if (panel === null || placement === "closed") return;
  const wasDocked = placement === "docked";
  panel.element.remove();
  placement = "closed";
  if (wasDocked) dock?.hide();
}

/**
 * The workspace offers its right-hand column while it is on screen (until `signal` aborts).
 * `open`: show the panel there at once (the column was on the Assistant tab last time). A panel
 * already over the screen moves into the column.
 */
export function offerAssistantDock(next: AssistantDock, open: boolean, signal: AbortSignal): void {
  dock = next;
  signal.addEventListener(
    "abort",
    () => {
      if (dock !== next) return;
      dock = null;
      if (placement === "docked") {
        panel?.element.remove();
        placement = "closed";
      }
    },
    { once: true },
  );
  if (open || placement === "floating") openAssistant(undefined, { focus: false });
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

    const section = h(
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
    );
    answerArea.replaceChildren(section);
    // The draft comes below the request box: bring it into view (in the workspace's narrow column
    // it would start below the bottom edge).
    const top = scroller.scrollTop + section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
    scroller.scrollTo({ top, behavior: "smooth" });
  }

  async function useAnswer(netlist: string, idea: string, target: OpenDoc | null): Promise<void> {
    try {
      const open = currentDoc();
      if (target === null && open !== null && open.draft.gates.length === 0) {
        // A new, empty circuit takes the answer itself, so Save still puts it where that circuit
        // was going (your account, for a new circuit started from the server's lists).
        await applyNetlist(open, netlist);
        if (open.draft.description === "") open.draft.description = idea;
        used(open, "The workspace now holds the assistant's circuit. Check it, then save it.");
        return;
      }
      if (target === null || target !== open) {
        const opened = await openUnsavedText(netlist, idea);
        if (opened !== null) used(opened, "The workspace now holds the assistant's circuit. Check it, then save it.");
        return; // null: the person kept the open circuit
      }
      // A change to the open circuit: it stays where it's saved, with unsaved changes, and can be undone.
      const before = snapshot(target);
      await applyNetlist(target, netlist);
      const after = fingerprint(target);
      used(target, "The assistant's change is in the open circuit. Check it, then save it.", () => {
        // Only while it's still open and as the assistant left it: otherwise Undo would also throw
        // away what was done since.
        if (currentDoc() !== target || fingerprint(target) !== after) return false;
        restore(target, before);
        goTo("/workspace");
        return true;
      });
    } catch (error) {
      warning.replaceChildren(errorBox(error));
    }
  }

  /**
   * After a draft went into the workspace. Over another screen, the panel closes and the workspace
   * shows the circuit, simulated. Beside the circuit the panel stays, and so does the mode you were
   * in (drawing, say): the panel itself says what happened, with the Undo. `undo` returns false
   * when it can't undo any more (the circuit changed since).
   */
  function used(doc: OpenDoc, message: string, undo?: () => boolean): void {
    const refused = "Not undone: the circuit has changed since the assistant's change, and undoing would lose that.";
    if (placement !== "docked") {
      doc.mode = "sim";
      closeAssistant();
      goTo("/workspace");
      if (undo === undefined) {
        toast(message);
        return;
      }
      toast(message, {
        action: {
          label: "Undo",
          run: () => {
            if (!undo()) toast(refused, { error: true });
          },
        },
      });
      return;
    }
    answerArea.replaceChildren();
    const note = h("div", { class: "alert ok", role: "status" }, message);
    if (undo !== undefined) {
      const button = h("button", { type: "button", class: "link-btn" }, "Undo");
      button.addEventListener("click", () => {
        if (undo()) warning.replaceChildren();
        else warning.replaceChildren(h("div", { class: "alert warn" }, refused));
      });
      note.append(" ", button);
    }
    warning.replaceChildren(note);
    goTo("/workspace"); // shows the new circuit; the panel moves into the new page's column
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
  const scroller = h(
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
  );
  const element = h(
    "aside",
    { class: "assistant", "aria-label": "Ask the assistant" },
    h("div", { class: "as-head" }, h("h2", {}, "Ask the assistant"), close),
    scroller,
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

/**
 * The circuit as it is: what Undo must find unchanged since the assistant's change. Gate positions
 * aren't in it (moving gates around doesn't stop an undo); netlist text being typed is.
 */
function fingerprint(doc: OpenDoc): string {
  const { draft } = doc;
  return JSON.stringify([draft.name, draft.description, draft.gates, draft.wires, [...draft.pins], doc.netText]);
}

function restore(doc: OpenDoc, before: Snapshot): void {
  // The change made the circuit unsaved, and only saving makes it clean again: if it's clean now,
  // the assistant's version was saved, and what Undo brings back isn't.
  const savedSince = !doc.dirty;
  doc.draft = before.draft;
  doc.text = before.text;
  doc.netText = before.netText;
  doc.dirty = savedSince || before.dirty;
  doc.state = undefined;
  doc.steps = 0;
  syncInputs(doc);
  docChanged();
}
