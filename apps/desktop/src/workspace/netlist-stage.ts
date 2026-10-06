import { requireDesktop, unwrap } from "../desktop";
import { h } from "../dom";
import { toast } from "../shell/toast";
import { errorDetails, errorMessage } from "../ui";
import type { Ws } from "./context";
import { NETLIST_TEMPLATE, writeNetlist } from "./netlist-text";
import { applyNetlist, docChanged, type OpenDoc } from "./store";
import { describeSummary } from "./summary";

/**
 * The Netlist mode: the circuit as text, one gate per line, with line numbers. Typing changes only
 * the text; "Apply to drawing" makes it the circuit (and Save applies it first). Good for big
 * circuits, and for pasting.
 */
export interface NetlistStage {
  readonly nodes: readonly HTMLElement[];
  /** Puts the cursor on a line (from the problems listed in the inspector). */
  jumpTo(line: number): void;
  /** Applies the text if it differs from the circuit. Resolves to false if it has mistakes. */
  applyIfChanged(): Promise<boolean>;
}

export interface NetlistActions {
  /** The text became the circuit. */
  applied(): void;
  /** A check finished: the inspector lists its problems. */
  checked(): void;
}

/** The text the editor starts with: what was being typed, else the circuit's own netlist. */
export function startingText(doc: OpenDoc): string {
  if (doc.netText !== null) return doc.netText;
  if (doc.text !== null) return doc.text;
  if (doc.draft.gates.length === 0) return NETLIST_TEMPLATE;
  return writeNetlist(doc.draft, doc.draft.pins);
}

export function createNetlistStage(ws: Ws, actions: NetlistActions): NetlistStage {
  const { doc } = ws;
  const original = startingText(doc);
  const text = h("textarea", { class: "net-text", spellcheck: "false", wrap: "off", "aria-label": "Netlist" }, original);
  const gutter = h("div", { class: "net-gutter", "aria-hidden": "true" });
  const message = h("span", { class: "net-msg" });

  function redraw(): void {
    const lines = text.value.split("\n");
    const bad = new Set(ws.netCheck !== null && !ws.netCheck.ok ? errorDetails(ws.netCheck.error).issues.map((issue) => issue.line) : []);
    gutter.replaceChildren(...lines.map((_, index) => h("div", { class: bad.has(index + 1) ? "bad" : null }, String(index + 1))));
    text.style.height = `${lines.length * 20 + 60}px`;
    const result = ws.netCheck;
    if (result === null) {
      message.className = "net-msg";
      message.textContent = "Edit the text, then Check or Apply.";
    } else if (result.ok) {
      message.className = "net-msg ok";
      message.textContent = result.text;
    } else {
      const count = errorDetails(result.error).issues.length;
      message.className = "net-msg bad";
      message.textContent = count > 0 ? `${count} problem${count === 1 ? "" : "s"} found` : errorMessage(result.error);
    }
  }

  text.addEventListener("input", () => {
    doc.netText = text.value;
    if (!doc.dirty) {
      doc.dirty = true;
      docChanged();
    }
    if (ws.netCheck !== null) {
      ws.netCheck = null;
      actions.checked();
    }
    redraw();
  });
  // Tab inserts spaces instead of leaving the editor (lines are aligned with spaces).
  text.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || event.shiftKey) return;
    event.preventDefault();
    text.setRangeText("    ", text.selectionStart, text.selectionEnd, "end");
    text.dispatchEvent(new Event("input"));
  });

  async function check(): Promise<boolean> {
    try {
      const circuit = unwrap(await requireDesktop().parse(text.value));
      ws.netCheck = { ok: true, text: `Looks good: ${describeSummary(circuit.summary, circuit.gates.length)}` };
      return true;
    } catch (error) {
      ws.netCheck = { ok: false, error };
      const first = errorDetails(error).issues.find((issue) => issue.line !== undefined);
      if (first?.line !== undefined) jumpTo(first.line);
      return false;
    } finally {
      redraw();
      actions.checked();
    }
  }

  async function apply(): Promise<boolean> {
    try {
      const circuit = await applyNetlist(doc, text.value);
      ws.netCheck = { ok: true, text: `Applied: ${describeSummary(circuit.summary, circuit.gates.length)}` };
      redraw();
      actions.applied();
      return true;
    } catch (error) {
      ws.netCheck = { ok: false, error };
      const first = errorDetails(error).issues.find((issue) => issue.line !== undefined);
      if (first?.line !== undefined) jumpTo(first.line);
      redraw();
      actions.checked();
      return false;
    }
  }

  function jumpTo(line: number): void {
    const lines = text.value.split("\n");
    let start = 0;
    for (let index = 0; index < line - 1 && index < lines.length; index++) start += (lines[index]?.length ?? 0) + 1;
    text.focus();
    text.setSelectionRange(start, start + (lines[line - 1]?.length ?? 0));
    text.closest(".net-scroll")?.scrollTo({ top: Math.max(0, (line - 4) * 20) });
  }

  const checkButton = h("button", { type: "button", class: "btn md" }, "Check");
  checkButton.addEventListener("click", () => void check());
  const applyButton = h("button", { type: "button", class: "btn md primary", title: "Make this text the circuit (the drawing follows)" }, "Apply to drawing");
  applyButton.addEventListener("click", () => {
    void apply().then((ok) => {
      if (ok) toast("Drawing updated from the netlist.");
    });
  });

  redraw();
  return {
    nodes: [
      h(
        "div",
        { class: "net" },
        h("div", { class: "net-bar" }, checkButton, applyButton, message),
        h("div", { class: "net-scroll" }, h("div", { class: "net-grid" }, gutter, text)),
      ),
    ],
    jumpTo,
    async applyIfChanged() {
      if (doc.netText === null || doc.netText === doc.text) return true;
      return apply();
    },
  };
}
