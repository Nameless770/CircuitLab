import type { Bit } from "@circuitlab/engine";
import { PIN_RANGE } from "../diagram/geometry";
import { h } from "../dom";
import { renameGate, setConstValue, setLabel, setPinCount } from "../editor/draft";
import { errorBox, errorDetails, errorMessage, field } from "../ui";
import { summaryOf, type Ws } from "./context";
import { serverPanels } from "./server-panels";
import { docChanged } from "./store";

/**
 * The panel on the right of the workspace. What it shows depends on the mode:
 * - Simulate: the input switches, the output lamps, what a latch remembers, and for a circuit on
 *   the server, its sharing, history and background jobs;
 * - Draw: the selected gate or wire, and the circuit's name and description;
 * - Netlist: a cheat sheet, and the problems the last check found.
 */
export interface InspectorActions {
  toggleInput(id: string): void;
  reset(): void;
  /** The drawing changed from here (a gate renamed, ...): redraw it and simulate again. */
  edited(): void;
  deleteSelection(): void;
  checkDrawing(): void;
  jumpToLine(line: number): void;
}

export function renderInspector(ws: Ws, actions: InspectorActions): HTMLElement[] {
  switch (ws.doc.mode) {
    case "sim":
      return simulatePanel(ws, actions);
    case "draw":
      return drawPanel(ws, actions);
    case "net":
      return netlistPanel(ws, actions);
  }
}

// ---- Simulate -----------------------------------------------------------------------------------

function simulatePanel(ws: Ws, actions: InspectorActions): HTMLElement[] {
  const { doc } = ws;
  const summary = summaryOf(ws);
  const labels = new Map(doc.draft.gates.map((gate) => [gate.id, gate.label]));
  const sequential = summary.feedbackLoop !== null;

  const inputs = h(
    "section",
    { class: "ins-section tight", "aria-label": "Inputs" },
    h("div", { class: "ins-head" }, h("span", { class: "label" }, "Inputs"), h("span", { class: "hint" }, summary.inputs.length === 0 ? "" : `keys 1–${Math.min(9, summary.inputs.length)}`)),
    summary.inputs.length === 0 ? h("p", { class: "muted" }, "None.") : null,
    summary.inputs.map((id, index) => {
      const on = doc.inputs[id] === 1;
      const toggle = h("button", { type: "button", class: "toggle", "aria-pressed": on ? "true" : "false", "aria-label": `Input ${id}`, title: `Turn ${id} ${on ? "off" : "on"}` }, h("span", { class: "toggle-knob" }));
      toggle.addEventListener("click", () => actions.toggleInput(id));
      return h(
        "div",
        { class: "io-row", "data-io": id },
        h("span", { class: "io-key" }, index < 9 ? String(index + 1) : ""),
        ioName(id, labels.get(id)),
        h("span", { class: on ? "io-bit one" : "io-bit" }, on ? "1" : "0"),
        toggle,
      );
    }),
  );

  const outputs = h(
    "section",
    { class: "ins-section tight", "aria-label": "Outputs" },
    h("div", { class: "ins-head" }, h("span", { class: "label" }, "Outputs")),
    summary.outputs.length === 0 ? h("p", { class: "muted" }, "None.") : null,
    summary.outputs.map((id) => {
      const value: Bit | undefined = ws.last?.outputs[id];
      return h(
        "div",
        { class: "out-row", "data-io": id },
        ioName(id, labels.get(id)),
        h("span", { class: value === 1 ? "out-bit one" : "out-bit", "data-value": value === undefined ? "" : String(value) }, value === undefined ? "–" : String(value)),
        h("span", { class: value === 1 ? "lamp on" : "lamp", "aria-hidden": "true" }),
      );
    }),
  );

  const parts: HTMLElement[] = [inputs, outputs];
  if (sequential) {
    const remembered = doc.state === undefined ? "nothing yet (every gate starts at 0)" : Object.entries(doc.state).map(([id, value]) => `${id}=${value}`).join(", ");
    const reset = h("button", { type: "button", class: "btn md", title: "Forget what the circuit remembers and set every input to 0 (R)" }, "Reset");
    reset.addEventListener("click", actions.reset);
    parts.push(
      h(
        "section",
        { class: "seq-box" },
        h("span", { class: "badge sig" }, "remembers state"),
        h(
          "span",
          { class: "muted" },
          `This circuit has a feedback loop (${summary.feedbackLoop?.join(" → ") ?? ""}), so it's simulated step by step: each flip is one step, and the loop remembers its value between steps.`,
        ),
        h("span", { class: "mono", style: "font-size:12px" }, `Remembers: ${remembered}`),
        reset,
      ),
    );
  }
  if (ws.simStatus.kind === "error") parts.push(errorBox(ws.simStatus.error));
  parts.push(...serverPanels(ws));
  parts.push(
    h(
      "div",
      { class: "sim-status", "aria-live": "polite" },
      h("span", { class: ws.simStatus.kind === "error" ? "led small bad" : "led small ok" }),
      h("span", {}, ws.simStatus.text),
    ),
  );
  return parts;
}

function ioName(id: string, label: string | undefined): HTMLElement {
  return h("span", { class: "io-name", title: label === undefined ? id : `${id}: ${label}` }, h("span", { class: "io-id" }, id), label === undefined ? null : h("span", { class: "io-label" }, ` ${label}`));
}

// ---- Draw ---------------------------------------------------------------------------------------

function drawPanel(ws: Ws, actions: InspectorActions): HTMLElement[] {
  const { doc } = ws;
  const selection = ws.selection;
  const gate = selection?.kind === "gate" ? doc.draft.gates.find((candidate) => candidate.id === selection.id) : undefined;
  const wire = selection?.kind === "wire" ? doc.draft.wires[selection.index] : undefined;

  const section = h("section", { class: "ins-section" }, h("span", { class: "label" }, gate !== undefined ? `${gate.type} gate` : wire !== undefined ? "Wire" : "How to"));
  if (gate !== undefined) {
    const name = h("input", { type: "text", class: "input mono", value: gate.id, maxlength: 64, "aria-label": "Gate name" });
    name.addEventListener("change", () => {
      const error = renameGate(doc.draft, gate.id, name.value.trim());
      ws.nameError = error;
      if (error === null) ws.selection = { kind: "gate", id: name.value.trim() };
      actions.edited();
    });
    name.addEventListener("keydown", (event) => {
      if (event.key === "Enter") name.blur();
    });
    const isPort = gate.type === "INPUT" || gate.type === "OUTPUT";
    section.append(field("Name", name, isPort ? "Simulations know inputs and outputs by this name." : undefined));
    if (ws.nameError !== null) section.append(h("div", { class: "alert error" }, ws.nameError));

    const label = h("input", { type: "text", class: "input", value: gate.label ?? "", maxlength: 200, placeholder: "Optional, e.g. Carry in", "aria-label": "Gate label" });
    label.addEventListener("change", () => {
      setLabel(doc.draft, gate.id, label.value);
      actions.edited();
    });
    section.append(field("Label", label));

    const range = PIN_RANGE[gate.type];
    if (range.min !== range.max) {
      const count = doc.draft.pins.get(gate.id) ?? range.min;
      const change = (delta: number): void => {
        setPinCount(doc.draft, gate.id, count + delta);
        actions.edited();
      };
      const less = h("button", { type: "button", "aria-label": "One input less", disabled: count <= range.min }, "−");
      less.addEventListener("click", () => change(-1));
      const more = h("button", { type: "button", "aria-label": "One input more", disabled: count >= range.max }, "+");
      more.addEventListener("click", () => change(1));
      section.append(
        h(
          "div",
          { class: "field" },
          h("span", { class: "field-label" }, "Number of inputs"),
          h("div", { class: "stepper" }, less, h("output", {}, String(count)), more),
          h("span", { class: "field-hint" }, `${range.min} to ${range.max}. Removing inputs removes their wires.`),
        ),
      );
    }
    if (gate.type === "CONST") {
      const choices = h("div", { class: "choice-row", role: "group", "aria-label": "Value" });
      for (const value of [0, 1] as const) {
        const button = h("button", { type: "button", "aria-pressed": gate.value === value ? "true" : "false" }, String(value));
        button.addEventListener("click", () => {
          setConstValue(doc.draft, gate.id, value);
          actions.edited();
        });
        choices.append(button);
      }
      section.append(h("div", { class: "field" }, h("span", { class: "field-label" }, "Value"), choices));
    }
    const remove = h("button", { type: "button", class: "btn danger self-start" }, "Delete gate ", h("span", { class: "kbd" }, "Del"));
    remove.addEventListener("click", actions.deleteSelection);
    section.append(remove);
  } else if (wire !== undefined) {
    const remove = h("button", { type: "button", class: "btn danger self-start" }, "Delete wire");
    remove.addEventListener("click", actions.deleteSelection);
    section.append(h("p", {}, `From ${wire.from} to input ${wire.toPin + 1} of ${wire.to}.`), remove);
  } else {
    section.append(
      h(
        "ul",
        { class: "help-list" },
        h("li", {}, "Add gates with the buttons on the left of the drawing, then drag them where you like."),
        h("li", {}, "To connect two gates, drag from a gate's right dot (its output) to another gate's left dot (an input)."),
        h("li", {}, "Click a gate or a wire to select it. Delete removes it."),
        h("li", {}, "Every input dot needs exactly one wire. “Check” lists anything missing."),
        h("li", {}, "Ctrl+S saves."),
      ),
    );
  }

  // The circuit's own name and description.
  const name = h("input", { type: "text", class: "input", value: doc.draft.name, maxlength: 200, required: true, "aria-label": "Circuit name" });
  name.addEventListener("input", () => {
    doc.draft.name = name.value;
    doc.text = null; // the name is in the netlist (.name), so the text must be written again
    doc.netText = null;
    doc.dirty = true;
    docChanged();
  });
  const circuit = h("section", { class: "ins-section divided" }, h("span", { class: "label" }, "Circuit"), field("Name", name));
  // A netlist file has no place for a description.
  if (doc.source.kind !== "file") {
    const description = h("textarea", { class: "input", rows: 3, maxlength: 2000, placeholder: "Optional", "aria-label": "Description" }, doc.draft.description);
    description.addEventListener("input", () => {
      doc.draft.description = description.value;
      doc.dirty = true;
      docChanged();
    });
    circuit.append(field("Description", description));
  }
  const check = h("button", { type: "button", class: "btn self-start" }, "Check");
  check.addEventListener("click", actions.checkDrawing);
  circuit.append(check);
  const result = ws.drawCheck;
  if (result !== null && result.ok) circuit.append(h("div", { class: "alert ok" }, result.text));
  if (result !== null && !result.ok) {
    const issues = errorDetails(result.error).issues;
    circuit.append(
      issues.length === 0
        ? errorBox(result.error)
        : h("div", { class: "alert error", role: "alert" }, h("strong", {}, "Not ready yet:"), h("ul", {}, issues.map((issue) => h("li", {}, issue.message)))),
    );
  }
  return [section, circuit];
}

// ---- Netlist ------------------------------------------------------------------------------------

function netlistPanel(ws: Ws, actions: InspectorActions): HTMLElement[] {
  const section = h(
    "section",
    { class: "ins-section" },
    h("span", { class: "label" }, "Netlist cheat sheet"),
    h("pre", { class: "cheat" }, `.name "Half adder"\n\nA = INPUT\nB = INPUT  "a label"\none = CONST(1)\n\nsum   = XOR(A, B)\ncarry = AND(A, B)\n\nS = OUTPUT(sum)\nC = OUTPUT(carry)`),
    h(
      "ul",
      { class: "help-list" },
      h("li", {}, "Gate types: INPUT, OUTPUT, CONST, BUF, NOT, AND, OR, NAND, NOR, XOR, XNOR."),
      h("li", {}, "AND, OR, NAND, NOR, XOR and XNOR take 2 to 64 inputs; NOT, BUF and OUTPUT take one."),
      h("li", {}, "A name can be used before the line that defines it."),
      h("li", {}, "Names: letters, digits and _ . $ [ ], not starting with a dot."),
      h("li", {}, "# starts a comment."),
    ),
  );
  const result = ws.netCheck;
  if (result !== null && !result.ok) {
    const issues = errorDetails(result.error).issues;
    if (issues.length === 0) {
      section.append(h("div", { class: "alert error" }, errorMessage(result.error)));
    } else {
      section.append(
        h(
          "div",
          { class: "issues-box", role: "alert" },
          issues.map((issue) => {
            const line = issue.line;
            const item = h("button", { type: "button", class: "issue" }, h("span", { class: "where" }, line === undefined ? "" : `L${line}`), h("span", {}, issue.message));
            if (line !== undefined) item.addEventListener("click", () => actions.jumpToLine(line));
            return item;
          }),
        ),
      );
    }
  }
  return [section];
}
