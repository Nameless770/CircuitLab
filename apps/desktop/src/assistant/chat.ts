import type { AssistantAnswer, AssistantProgress, DesktopBridge } from "../../electron/bridge";
import { renderTruthTable } from "../circuit/truth-table";
import { LocalError, unwrap } from "../desktop";
import { thumbnail } from "../diagram/thumb";
import { h, plural } from "../dom";
import type { Draft } from "../editor/draft";
import { on } from "../shell/bus";
import { goTo } from "../shell/commands";
import { assistantState, checkAssistant } from "../shell/status";
import { toast } from "../shell/toast";
import { errorBox } from "../ui";
import { startingText } from "../workspace/netlist-stage";
import { applyNetlist, currentDoc, docChanged, onDocChange, openUnsavedText, syncInputs, type OpenDoc } from "../workspace/store";

/**
 * The assistant's chat: what you asked, and what it drafted, one after the other. Each message
 * makes a circuit or changes one, and a follow-up builds on what came before:
 * - on the last draft, while it isn't used yet ("now add an enable input");
 * - on the open circuit, once the last draft is in it (so your own edits since count too);
 * - on nothing, for a new circuit.
 * The box you type in says which ("Builds on"), and you can choose another.
 *
 * The model itself is asked exactly as before: one request, and the circuit to change. The
 * conversation's memory is the circuit, which suits a small model better than the whole chat would
 * (it would fill its memory, and its accuracy was measured this way; see docs/assistant.md).
 * The chat lives as long as the app is open; "New chat" starts over.
 */

/** Things to try: they fill the box. */
const EXAMPLE_REQUESTS = ["a full adder", "a 2-to-1 multiplexer with inputs D0, D1 and SEL", "a circuit that is 1 when at least two of A, B and C are 1", "an SR latch from NOR gates"];

/** Longest request: the same as the assistant's own limit (MAX_REQUEST_CHARS in @circuitlab/assistant). */
const MAX_REQUEST_CHARS = 1_000;

export type AskMode = "new" | "change";

/** What a message builds on. */
type Basis = { readonly kind: "new" } | { readonly kind: "draft"; readonly draft: DraftReply } | { readonly kind: "open"; readonly doc: OpenDoc };

type CircuitAnswer = Extract<AssistantAnswer, { kind: "circuit" }>;

/** A circuit the assistant drafted, as it stands in the chat. */
interface DraftReply {
  readonly answer: CircuitAnswer;
  /** The open circuit it is a change of (through earlier drafts, maybe), or null for a new circuit. */
  readonly destination: OpenDoc | null;
  /** fresh: not used yet. used: it's in the workspace. set aside: discarded, or undone; follow-ups don't build on it. */
  state: "fresh" | "used" | "set aside";
  /** The picture, the table and the netlist: folded away when a newer draft arrives. */
  readonly more: HTMLDetailsElement;
  /** The buttons, and what happened to the draft. */
  readonly footer: HTMLElement;
}

export interface ChatPanel {
  readonly element: HTMLElement;
  /** "change": the next message changes the open circuit; "new": it asks for a new one. */
  setMode(mode: AskMode): void;
  focus(): void;
  /** After the panel is shown again: what's open, and whether Ollama answers, may have changed. */
  redraw(): void;
}

/** Where the panel is shown (drawer.ts decides). */
export interface ChatHost {
  /** Beside the circuit, in the workspace's column (it stays open), rather than over a screen (it closes). */
  docked(): boolean;
  close(): void;
}

// The main process sends progress for whichever question is being worked on. The bridge can't take
// a listener away again, so there is one listener, which passes progress to the question waiting.
let progressListener: ((progress: AssistantProgress) => void) | null = null;
let listening = false;

export function makeChatPanel(bridge: DesktopBridge, host: ChatHost): ChatPanel {
  if (!listening) {
    listening = true;
    bridge.onAssistantProgress((progress) => progressListener?.(progress));
  }
  let working = false;
  /** The newest draft in the chat. */
  let latest: DraftReply | null = null;
  /** What the person chose for the next message to build on; null: the usual (see the top). */
  let chosen: Basis["kind"] | null = null;

  const chips = EXAMPLE_REQUESTS.map((text) => {
    const chip = h("button", { type: "button", class: "chip" }, text);
    chip.addEventListener("click", () => {
      request.value = text;
      warning.replaceChildren();
      request.focus();
    });
    return chip;
  });
  // Whether Ollama answers, and where: at the start of a chat (each draft says which model made it).
  const status = h("div", { class: "as-note" });
  const intro = h(
    "div",
    { class: "as-intro" },
    h("p", { class: "muted" }, "Describe a circuit in words, or a change to the open one. A language model running on this computer (Ollama) drafts it, and you check it before it goes in the workspace. Ask for more changes as you go."),
    status,
    h("div", { class: "chips" }, h("span", { class: "muted small" }, "Try:"), chips),
  );
  const thread = h("div", { class: "as-thread" }, intro);
  const basisChoice = h("div", { class: "seg sm", role: "group", "aria-label": "Builds on" });
  const request = h("textarea", {
    class: "as-request",
    rows: "2",
    maxlength: String(MAX_REQUEST_CHARS),
    "aria-label": "What circuit do you want?",
    placeholder: "Ask for a circuit, or a change. Enter sends; Shift+Enter starts a new line.",
  });
  const warning = h("div");
  const newChat = h("button", { type: "button", class: "btn md ghost", title: "Forget this chat and start over" }, "New chat");
  const cancel = h("button", { type: "button", class: "btn md", hidden: true }, "Cancel");
  const send = h("button", { type: "button", class: "btn md primary", title: "Enter" }, "Send");

  // ---- what the next message builds on ---------------------------------------------------------------

  function choices(): { draft: DraftReply | null; open: OpenDoc | null } {
    const doc = currentDoc();
    const open = doc !== null && doc.draft.gates.length > 0 ? doc : null;
    // The last draft, while it's neither used nor set aside, and is about what's open (or about something new).
    const draft = latest !== null && latest.state === "fresh" && (latest.destination === null || latest.destination === doc) ? latest : null;
    return { draft, open };
  }

  function basis(): Basis {
    const { draft, open } = choices();
    if (chosen === "new") return { kind: "new" };
    if (chosen === "open" && open !== null) return { kind: "open", doc: open };
    if (draft !== null) return { kind: "draft", draft };
    if (open !== null) return { kind: "open", doc: open };
    return { kind: "new" };
  }

  function drawBasis(): void {
    const { draft, open } = choices();
    const current = basis().kind;
    const option = (kind: Basis["kind"], label: string, title: string, enabled: boolean): HTMLButtonElement => {
      const button = h("button", { type: "button", "aria-pressed": current === kind ? "true" : "false", disabled: !enabled, title }, label);
      button.addEventListener("click", () => {
        chosen = kind;
        drawBasis();
      });
      return button;
    };
    basisChoice.replaceChildren(
      option("draft", "Last draft", draft === null ? "No draft to build on" : `Change the draft “${draft.answer.circuit.name}”`, draft !== null),
      option("open", "Open circuit", open === null ? "Open a circuit with gates first" : `Change “${open.draft.name}” as it is now`, open !== null),
      option("new", "New circuit", "Ask for a new circuit", true),
    );
  }
  onDocChange(drawBasis); // another circuit opened, or the open one emptied: the choices change

  function basisLabel(on: Basis): string {
    if (on.kind === "draft") return `To change the draft “${on.draft.answer.circuit.name}”`;
    if (on.kind === "open") return `To change “${on.doc.draft.name}”`;
    return "For a new circuit";
  }

  // ---- whether Ollama answers ---------------------------------------------------------------------------

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

  // ---- asking -------------------------------------------------------------------------------------------

  async function submit(): Promise<void> {
    if (working) return;
    const wanted = request.value.trim();
    warning.replaceChildren();
    if (wanted === "") {
      warning.append(h("div", { class: "alert warn" }, "Write what circuit you want first."));
      request.focus();
      return;
    }
    const on = basis();
    chosen = null; // the message after this one goes back to the usual: on top of this one's answer
    request.value = "";
    fitBox();

    intro.remove();
    const you = h("div", { class: "chat-you" }, h("span", { class: "chat-basis" }, basisLabel(on)), h("span", {}, wanted));
    const reply = h("div", { class: "chat-reply" });
    thread.append(you, reply);
    thread.scrollTo({ top: thread.scrollHeight });

    working = true;
    send.disabled = true;
    cancel.hidden = false;
    const started = Date.now();
    const model = assistantState()?.model ?? "the model";
    let progress: AssistantProgress | null = null;
    const showWorking = (): void => {
      const seconds = Math.round((Date.now() - started) / 1000);
      const attempt = progress === null || progress.attempt === 1 ? "" : ` Attempt ${progress.attempt} of ${progress.of}: fixing ${plural(progress.problems, "problem")}.`;
      reply.replaceChildren(h("div", { class: "as-working", role: "status" }, h("span", {}, `Asking ${model}… ${seconds} s.${attempt}`), h("div", { class: "bar" }, h("div"))));
    };
    showWorking();
    const timer = setInterval(showWorking, 1000);
    progressListener = (next) => {
      progress = next;
      showWorking();
    };
    try {
      const netlist = on.kind === "draft" ? on.draft.answer.netlist : on.kind === "open" ? startingText(on.doc) : undefined;
      const answer = unwrap(await bridge.askAssistant({ request: wanted, ...(netlist !== undefined && { netlist }) }));
      showReply(reply, answer, on.kind === "open" ? on.doc : on.kind === "draft" ? on.draft.destination : null, wanted);
    } catch (error) {
      // Cancel is not a failure.
      const stopped = error instanceof LocalError && error.problem.code === "cancelled";
      reply.replaceChildren(stopped ? h("p", { class: "muted small" }, "Stopped.") : errorBox(error), askAgain(wanted));
      void checkAssistant(); // the likeliest reason for an error is that Ollama went away: show how it looks now
    } finally {
      clearInterval(timer);
      progressListener = null;
      working = false;
      send.disabled = false;
      cancel.hidden = true;
      drawBasis();
    }
    // Show the question, with its answer below it (a draft is tall: in the workspace's narrow
    // column its end may be below the edge, and that's fine).
    const top = thread.scrollTop + you.getBoundingClientRect().top - thread.getBoundingClientRect().top - 12;
    thread.scrollTo({ top, behavior: "smooth" });
  }

  /** A link that puts a request back in the box, to send it again (maybe reworded). */
  function askAgain(wanted: string): HTMLElement {
    const again = h("button", { type: "button", class: "link-btn" }, "Ask again");
    again.addEventListener("click", () => {
      request.value = wanted;
      fitBox();
      request.focus();
    });
    return h("p", { class: "small" }, again);
  }

  function showReply(reply: HTMLElement, answer: AssistantAnswer, destination: OpenDoc | null, wanted: string): void {
    if (answer.kind === "declined") {
      reply.replaceChildren(h("div", { class: "alert warn" }, h("strong", {}, "The assistant can't make that. "), answer.message));
      return;
    }
    if (answer.kind === "invalid") {
      reply.replaceChildren(
        h(
          "div",
          { class: "alert error", role: "alert" },
          h("strong", {}, `The assistant tried ${answer.attempts} times and couldn't make a circuit that works.`),
          h("ul", {}, answer.problems.map((problem) => h("li", {}, problem))),
          h("p", {}, "Try asking another way, or pick a bigger model in Settings."),
        ),
        askAgain(wanted),
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
    const more = h(
      "details",
      { class: "as-more", open: true },
      h("summary", {}, "Picture and truth table"),
      h("div", { class: "as-thumb" }, thumbnail(circuit)),
      behaviour,
      h("details", {}, h("summary", {}, "The netlist"), h("pre", { class: "netlist-text" }, answer.netlist)),
    );
    const footer = h("div", { class: "as-actions" });
    const card = h(
      "section",
      { class: "as-answer" },
      h("h3", {}, circuit.name),
      answer.idea === "" ? null : h("p", {}, answer.idea),
      h("span", { class: "mono muted small" }, `${plural(circuit.gates.length, "gate")}, ${inputs} → ${outputs}.`),
      more,
      h(
        "p",
        { class: "muted small" },
        `Made by ${answer.model}${answer.attempts > 1 ? ` after ${answer.attempts} tries` : ""}. A small model can be wrong: look at the truth table before you trust the circuit.`,
      ),
      footer,
    );
    const draft: DraftReply = { answer, destination, state: "fresh", more, footer };
    drawFooter(draft);
    // Only the newest draft shows its picture and table; the others fold away (a click opens them).
    if (latest !== null) latest.more.open = false;
    latest = draft;
    reply.replaceChildren(card);
  }

  // ---- what a draft can do ------------------------------------------------------------------------------

  /** The draft's buttons, after `note` (what happened to it, if anything). */
  function drawFooter(draft: DraftReply, note: HTMLElement | null = null): void {
    const parts: HTMLElement[] = note === null ? [] : [note];
    if (draft.state !== "used") {
      const use = h("button", { type: "button", class: "btn md primary" }, draft.destination === null ? "Use this in the editor" : "Use this in the open circuit");
      use.addEventListener("click", () => void useDraft(draft));
      const row = h("div", { class: "as-row" }, use);
      if (draft.state === "fresh") {
        const discard = h("button", { type: "button", class: "btn md", title: "The next message won't build on it" }, "Discard");
        discard.addEventListener("click", () => {
          draft.state = "set aside";
          drawFooter(draft, h("p", { class: "muted small" }, "Set aside: the next message won't build on it."));
          drawBasis();
        });
        row.append(discard);
      }
      parts.push(row);
    }
    draft.footer.replaceChildren(...parts);
  }

  async function useDraft(draft: DraftReply): Promise<void> {
    const { netlist, idea } = draft.answer;
    try {
      const open = currentDoc();
      if (draft.destination !== null && draft.destination === open) {
        // A change to the open circuit: it stays where it's saved, with unsaved changes, and can be undone.
        const before = snapshot(open);
        await applyNetlist(open, netlist);
        const after = fingerprint(open);
        used(draft, open, "The assistant's change is in the open circuit. Check it, then save it.", () => {
          // Only while it's still open and as the assistant left it: otherwise Undo would also throw
          // away what was done since.
          if (currentDoc() !== open || fingerprint(open) !== after) return false;
          restore(open, before);
          goTo("/workspace");
          return true;
        });
        return;
      }
      if (open !== null && open.draft.gates.length === 0) {
        // A new, empty circuit takes the answer itself, so Save still puts it where that circuit
        // was going (your account, for a new circuit started from the server's lists).
        await applyNetlist(open, netlist);
        if (open.draft.description === "") open.draft.description = idea;
        used(draft, open, "The workspace now holds the assistant's circuit. Check it, then save it.");
        return;
      }
      const opened = await openUnsavedText(netlist, idea);
      if (opened !== null) used(draft, opened, "The workspace now holds the assistant's circuit. Check it, then save it.");
      // null: the person kept the open circuit, with its unsaved changes
    } catch (error) {
      drawFooter(draft, errorBox(error));
    }
  }

  /**
   * After a draft went into the workspace. Over another screen, the panel closes and the workspace
   * shows the circuit, simulated. Beside the circuit the panel stays, and so does the mode you were
   * in (drawing, say); the draft's card says what happened, with the Undo. `undo` returns false
   * when it can't undo any more (the circuit changed since).
   */
  function used(draft: DraftReply, doc: OpenDoc, message: string, undo?: () => boolean): void {
    const refused = "Not undone: the circuit has changed since the assistant's change, and undoing would lose that.";
    const undoIt = (): boolean => {
      if (undo === undefined || !undo()) return false;
      draft.state = "set aside";
      drawFooter(draft, h("p", { class: "muted small" }, "Undone. You can still use it after all."));
      drawBasis();
      return true;
    };
    draft.state = "used";
    const note = h("div", { class: "alert ok", role: "status" }, message);
    if (undo !== undefined) {
      const button = h("button", { type: "button", class: "link-btn" }, "Undo");
      button.addEventListener("click", () => {
        if (!undoIt()) drawFooter(draft, h("div", { class: "alert warn" }, refused));
      });
      note.append(" ", button);
    }
    drawFooter(draft, note);
    drawBasis();
    if (host.docked()) {
      goTo("/workspace"); // shows the new circuit; the panel moves into the new page's column
      return;
    }
    doc.mode = "sim";
    host.close();
    goTo("/workspace");
    if (undo === undefined) {
      toast(message);
      return;
    }
    toast(message, {
      action: {
        label: "Undo",
        run: () => {
          if (!undoIt()) toast(refused, { error: true });
        },
      },
    });
  }

  // ---- the box you type in ------------------------------------------------------------------------------

  /** The box grows with what's typed, up to a few lines. */
  function fitBox(): void {
    request.style.height = "auto";
    request.style.height = `${Math.min(request.scrollHeight + 2, 160)}px`;
  }

  request.addEventListener("input", fitBox);
  request.addEventListener("keydown", (event) => {
    // Enter sends, as in any chat; Shift+Enter is a new line. (Not while an input method is composing.)
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    void submit();
  });
  send.addEventListener("click", () => void submit());
  cancel.addEventListener("click", () => void bridge.cancelAssistant());
  newChat.addEventListener("click", () => {
    if (working) void bridge.cancelAssistant();
    latest = null;
    chosen = null;
    thread.replaceChildren(intro);
    warning.replaceChildren();
    drawBasis();
    request.focus();
  });

  const close = h("button", { type: "button", class: "as-close", title: "Close (Esc)" }, "Esc");
  close.addEventListener("click", () => host.close());
  const element = h(
    "aside",
    { class: "assistant", "aria-label": "Ask the assistant" },
    h("div", { class: "as-head" }, h("h2", {}, "Ask the assistant"), close),
    thread,
    h(
      "div",
      { class: "as-composer" },
      h("div", { class: "as-basis" }, h("span", { class: "muted small" }, "Builds on"), basisChoice),
      request,
      warning,
      h("div", { class: "as-row" }, newChat, h("div", { class: "grow" }), cancel, send),
    ),
  );

  return {
    element,
    setMode(mode) {
      chosen = mode === "new" ? "new" : "open";
    },
    focus() {
      request.focus();
    },
    redraw() {
      drawBasis();
      drawStatus();
    },
  };
}

// ---- undoing a change --------------------------------------------------------------------------------

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
