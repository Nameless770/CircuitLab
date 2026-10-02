import type { CircuitInput } from "@circuitlab/api-contract";
import type { GateType } from "@circuitlab/engine";
import { MAX_DRAWN_GATES } from "../circuit/simulator";
import { drawDiagram, wirePath } from "../diagram/draw";
import { PIN_LENGTH, PIN_RANGE, add, inputPinPoint, outputPinPoint, type Point } from "../diagram/geometry";
import { autoLayout } from "../diagram/layout";
import { appendAll, h, s } from "../dom";
import { navigate, setLeaveCheck, type PageContext } from "../router";
import { errorDetails, field, pageHeader, runAction, successBox } from "../ui";
import { addGate, connect, removeGate, removeWire, renameGate, setConstValue, setLabel, setPinCount, toCircuitInput, type Draft } from "./draft";

/**
 * The drawing editor, used for circuits on the server and for netlist files alike: the page
 * that opens it says how to check and how to save (EditorOptions).
 *
 * This file only turns mouse and keyboard actions into calls to draft.ts, which holds the
 * editing rules, and redraws the diagram after each change.
 */
export interface EditorOptions {
  readonly title: string;
  readonly draft: Draft;
  readonly saveLabel: string;
  readonly cancelPath: string;
  /** Shown above the editor, e.g. that saving rewrites a file. */
  readonly note?: string;
  /** Validates without saving. Resolves to a short description for the user. */
  check(input: CircuitInput): Promise<string>;
  /** Saves. Resolves to the page to show next, or null if the user cancelled (a Save dialog). */
  save(draft: Draft): Promise<string | null>;
}

const PALETTE: readonly { readonly type: GateType; readonly label: string; readonly title: string }[] = [
  { type: "INPUT", label: "Input", title: "A switch: its value is set when you simulate." },
  { type: "OUTPUT", label: "Output", title: "Shows the signal on its input: a result of the circuit." },
  { type: "AND", label: "AND", title: "1 when every input is 1." },
  { type: "OR", label: "OR", title: "1 when at least one input is 1." },
  { type: "NOT", label: "NOT", title: "Inverts its input." },
  { type: "NAND", label: "NAND", title: "0 only when every input is 1." },
  { type: "NOR", label: "NOR", title: "1 only when every input is 0." },
  { type: "XOR", label: "XOR", title: "1 when an odd number of inputs are 1." },
  { type: "XNOR", label: "XNOR", title: "1 when an even number of inputs are 1." },
  { type: "BUF", label: "BUF", title: "Copies its input." },
  { type: "CONST", label: "0/1", title: "A fixed value, 0 or 1." },
];

/** Gates snap to this grid while dragged, which keeps drawings tidy. */
const GRID = 10;

type Selection = { readonly kind: "gate"; readonly id: string } | { readonly kind: "wire"; readonly index: number } | null;

/** One pin: input `index` of a gate, or its output. */
interface PinRef {
  readonly gate: string;
  readonly side: "in" | "out";
  readonly index: number;
}

/** What the mouse is doing while its button is held down. */
type Drag =
  | { readonly kind: "move"; readonly id: string; readonly grabOffset: Point; moved: boolean }
  | { readonly kind: "wire"; readonly from: PinRef; readonly start: Point; readonly line: SVGPathElement };

export function openEditor({ root, signal }: PageContext, options: EditorOptions): void {
  const draft = options.draft;
  if (draft.gates.length > MAX_DRAWN_GATES) {
    root.append(
      h(
        "div",
        { class: "card empty-state" },
        h("h1", {}, "Too big to draw"),
        h("p", {}, `This circuit has ${draft.gates.length.toLocaleString()} gates. A drawing that size isn't readable; edit it as a netlist instead.`),
        h("a", { class: "button", href: `#${options.cancelPath}` }, "Back"),
      ),
    );
    return;
  }

  let selection: Selection = null;
  let problemGates = new Set<string>();
  let dirty = false;
  let drag: Drag | null = null;

  const svg = s("svg", { class: "circuit-diagram editing" });
  const canvas = h("div", { class: "diagram editor-canvas" }, svg);
  const messages = h("div");
  const selectionCard = h("div", { class: "card" });

  // ---- drawing -------------------------------------------------------------------------------

  function redraw(): void {
    drawDiagram(svg, draft, {
      editing: true,
      selectedGate: selection?.kind === "gate" ? selection.id : null,
      selectedWire: selection?.kind === "wire" ? selection.index : null,
      problemGates,
      // Fill the visible area, so empty space can be clicked (to deselect) and gates added there.
      minWidth: canvas.clientWidth - 2,
      minHeight: Math.max(420, canvas.clientHeight - 2),
    });
  }

  /** While dragging, redraw at most once per screen refresh. */
  let frame = 0;
  function redrawSoon(): void {
    if (frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      redraw();
    });
  }

  /** After every change to the circuit. */
  function changed(): void {
    dirty = true;
    problemGates = new Set(); // the last check's complaints may not apply any more
    redraw();
  }

  function select(next: Selection): void {
    selection = next;
    redraw();
    renderSelectionCard();
  }

  function warn(text: string): void {
    messages.replaceChildren(h("div", { class: "alert alert-warning" }, text));
  }

  // ---- the mouse -----------------------------------------------------------------------------

  /** Mouse position in the drawing's own coordinates (works even if the page is zoomed). */
  function svgPoint(event: MouseEvent): Point {
    const matrix = svg.getScreenCTM();
    if (matrix === null) return { x: 0, y: 0 };
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: point.x, y: point.y };
  }

  function pinAt(element: Element | null): PinRef | null {
    const pin = element?.closest("[data-pin]");
    const gate = element?.closest("[data-gate]");
    if (pin === null || pin === undefined || gate === null || gate === undefined) return null;
    return { gate: gate.getAttribute("data-gate") ?? "", side: pin.getAttribute("data-pin") === "out" ? "out" : "in", index: Number(pin.getAttribute("data-index") ?? "0") };
  }

  function pinPosition(ref: PinRef): Point {
    const at = draft.positions.get(ref.gate) ?? { x: 0, y: 0 };
    const gate = draft.gates.find((candidate) => candidate.id === ref.gate);
    if (gate === undefined) return at;
    const pins = draft.pins.get(ref.gate) ?? 0;
    return add(at, ref.side === "out" ? outputPinPoint(gate.type, pins) : inputPinPoint(gate.type, pins, ref.index));
  }

  svg.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const target = event.target as Element;

    const pin = pinAt(target);
    if (pin !== null) {
      // Start a wire. It follows the mouse (in the overlay layer) until released on another pin.
      const line = s("path", { d: "" });
      svg.querySelector(".overlay")?.append(line);
      drag = { kind: "wire", from: pin, start: pinPosition(pin), line };
      event.preventDefault();
      return;
    }

    const gateId = target.closest("[data-gate]")?.getAttribute("data-gate");
    if (gateId !== null && gateId !== undefined) {
      const at = draft.positions.get(gateId) ?? { x: 0, y: 0 };
      const point = svgPoint(event);
      drag = { kind: "move", id: gateId, grabOffset: { x: point.x - at.x, y: point.y - at.y }, moved: false };
      select({ kind: "gate", id: gateId });
      event.preventDefault();
      return;
    }

    const wire = target.closest("[data-wire]")?.getAttribute("data-wire");
    select(wire === null || wire === undefined ? null : { kind: "wire", index: Number(wire) });
  });

  // Move and release are watched on the whole window, so a drag that leaves the drawing still
  // ends properly. `signal` removes these listeners when the user leaves the page.
  window.addEventListener(
    "pointermove",
    (event) => {
      if (drag === null) return;
      const point = svgPoint(event);
      if (drag.kind === "move") {
        const x = Math.max(PIN_LENGTH + 6, snap(point.x - drag.grabOffset.x));
        const y = Math.max(6, snap(point.y - drag.grabOffset.y));
        draft.positions.set(drag.id, { x, y });
        drag.moved = true;
        redrawSoon();
      } else {
        // A wire started at an output runs to the mouse; one started at an input runs from it.
        drag.line.setAttribute("d", drag.from.side === "out" ? wirePath(drag.start, point) : wirePath(point, drag.start));
      }
    },
    { signal },
  );

  window.addEventListener(
    "pointerup",
    (event) => {
      if (drag === null) return;
      const finished = drag;
      drag = null;
      if (finished.kind === "move") {
        if (finished.moved) {
          dirty = true; // positions are saved too
          redraw();
        }
        return;
      }
      finished.line.remove();
      const end = pinAt(document.elementFromPoint(event.clientX, event.clientY));
      if (end === null || (end.gate === finished.from.gate && end.side === finished.from.side && end.index === finished.from.index)) return;
      if (end.side === finished.from.side) {
        warn("Connect an output (the dot on a gate's right side) to an input (a dot on a gate's left side).");
        return;
      }
      const [output, input] = finished.from.side === "out" ? [finished.from, end] : [end, finished.from];
      const error = connect(draft, output.gate, input.gate, input.index);
      if (error !== null) {
        warn(error);
        return;
      }
      messages.replaceChildren();
      changed();
    },
    { signal },
  );

  window.addEventListener("resize", redrawSoon, { signal });

  // ---- the keyboard --------------------------------------------------------------------------

  window.addEventListener(
    "keydown",
    (event) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement;
      if ((event.key === "Delete" || event.key === "Backspace") && !typing && selection !== null) {
        event.preventDefault();
        deleteSelection();
      } else if (event.key === "Escape") {
        if (drag?.kind === "wire") drag.line.remove();
        drag = null;
        select(null);
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveButton.click();
      }
    },
    { signal },
  );

  function deleteSelection(): void {
    if (selection?.kind === "gate") removeGate(draft, selection.id);
    if (selection?.kind === "wire") removeWire(draft, selection.index);
    selection = null;
    changed();
    renderSelectionCard();
  }

  // ---- adding gates --------------------------------------------------------------------------

  function addFromPalette(type: GateType): void {
    const gate = addGate(draft, type, freeSpot(type));
    selection = { kind: "gate", id: gate.id };
    changed();
    renderSelectionCard();
  }

  /**
   * A spot in the visible part of the drawing that no gate is using. Like the automatic layout,
   * inputs start on the left, outputs on the right, and the other gates in between.
   */
  function freeSpot(type: GateType): Point {
    const column = type === "INPUT" || type === "CONST" ? 0 : type === "OUTPUT" ? 2 : 1;
    const left = snap(canvas.scrollLeft + 60 + column * 180);
    const top = snap(canvas.scrollTop + 40);
    const used = [...draft.positions.values()];
    const taken = (spot: Point): boolean => used.some((other) => Math.abs(other.x - spot.x) < 80 && Math.abs(other.y - spot.y) < 56);
    let spot = { x: left, y: top };
    for (let tries = 0; tries < 300 && taken(spot); tries++) {
      spot = spot.y + 70 > top + Math.max(300, canvas.clientHeight - 100) ? { x: spot.x + 130, y: top } : { x: spot.x, y: spot.y + 70 };
    }
    return spot;
  }

  // ---- the side panel ------------------------------------------------------------------------

  const nameInput = h("input", { type: "text", value: draft.name, required: true, maxlength: 200 });
  nameInput.addEventListener("input", () => {
    draft.name = nameInput.value;
    dirty = true;
  });
  const descriptionInput = h("textarea", { rows: 3, maxlength: 2000, placeholder: "Optional" }, draft.description);
  descriptionInput.addEventListener("input", () => {
    draft.description = descriptionInput.value;
    dirty = true;
  });
  const circuitCard = h("div", { class: "card" }, h("h3", {}, "Circuit"), field("Name", nameInput), field("Description", descriptionInput));

  function renderSelectionCard(): void {
    const current = selection;
    if (current?.kind === "wire") {
      const wire = draft.wires[current.index];
      if (wire !== undefined) {
        const remove = h("button", { class: "danger" }, "Delete wire");
        remove.addEventListener("click", deleteSelection);
        selectionCard.replaceChildren(h("h3", {}, "Wire"), h("p", {}, `From ${wire.from} to input ${wire.toPin + 1} of ${wire.to}.`), remove);
        return;
      }
    }
    const gate = current?.kind === "gate" ? draft.gates.find((candidate) => candidate.id === current.id) : undefined;
    if (gate === undefined) {
      selectionCard.replaceChildren(h("h3", {}, "How to"), helpList());
      return;
    }

    const name = h("input", { type: "text", value: gate.id, maxlength: 64 });
    const nameMessage = h("div");
    name.addEventListener("change", () => {
      const newId = name.value.trim();
      const error = renameGate(draft, gate.id, newId);
      if (error !== null) {
        nameMessage.replaceChildren(h("div", { class: "alert alert-error" }, error));
        return;
      }
      selection = { kind: "gate", id: newId };
      changed();
      renderSelectionCard();
    });
    const label = h("input", { type: "text", value: gate.label ?? "", maxlength: 200, placeholder: "Optional, e.g. Carry in" });
    label.addEventListener("change", () => {
      setLabel(draft, gate.id, label.value);
      changed();
    });
    const isPort = gate.type === "INPUT" || gate.type === "OUTPUT";
    const fields: HTMLElement[] = [field("Name", name, isPort ? "Simulations know inputs and outputs by this name." : undefined), nameMessage, field("Label", label)];

    const range = PIN_RANGE[gate.type];
    if (range.min !== range.max) {
      const pins = h("input", { type: "number", min: range.min, max: range.max, value: draft.pins.get(gate.id) ?? range.min });
      pins.addEventListener("change", () => {
        setPinCount(draft, gate.id, Number(pins.value));
        changed();
      });
      fields.push(field("Number of inputs", pins, `${range.min} to ${range.max}. Removing inputs removes their wires.`));
    }
    if (gate.type === "CONST") {
      const value = h("select", {}, h("option", { value: "0", selected: gate.value === 0 }, "0"), h("option", { value: "1", selected: gate.value === 1 }, "1"));
      value.addEventListener("change", () => {
        setConstValue(draft, gate.id, value.value === "1" ? 1 : 0);
        changed();
      });
      fields.push(field("Value", value));
    }
    const remove = h("button", { class: "danger" }, "Delete gate");
    remove.addEventListener("click", deleteSelection);
    selectionCard.replaceChildren(h("h3", {}, `${gate.type} gate`), ...fields, remove);
  }

  // ---- checking and saving -------------------------------------------------------------------

  /** Outlines in red the gates the last check or save complained about. */
  function markProblems(error: unknown): void {
    const ids = new Set<string>();
    for (const issue of errorDetails(error).issues) {
      if (issue.gateId !== undefined) ids.add(issue.gateId);
      const match = /^\/(gates|wires)\/(\d+)/.exec(issue.pointer ?? "");
      if (match?.[1] === "gates") {
        const gate = draft.gates[Number(match[2])];
        if (gate !== undefined) ids.add(gate.id);
      }
      if (match?.[1] === "wires") {
        const wire = draft.wires[Number(match[2])];
        if (wire !== undefined) ids.add(wire.to);
      }
    }
    problemGates = ids;
    redraw();
  }

  const checkButton = h("button", {}, "Check");
  checkButton.addEventListener("click", () => {
    void runAction(checkButton, messages, async () => {
      try {
        messages.replaceChildren(successBox(await options.check(toCircuitInput(draft))));
      } catch (error) {
        markProblems(error);
        throw error; // runAction shows it
      }
    });
  });

  const saveButton = h("button", { class: "primary" }, options.saveLabel);
  saveButton.addEventListener("click", () => {
    if (draft.name.trim() === "") {
      warn("Give the circuit a name first.");
      nameInput.focus();
      return;
    }
    void runAction(saveButton, messages, async () => {
      try {
        const next = await options.save(draft);
        if (next === null) return; // the user cancelled the Save dialog
        dirty = false;
        navigate(next);
      } catch (error) {
        markProblems(error);
        throw error;
      }
    });
  });

  const arrange = h("button", { class: "small", title: "Place every gate automatically, left to right" }, "Arrange automatically");
  arrange.addEventListener("click", () => {
    draft.positions = autoLayout(draft.gates, draft.wires);
    changed();
  });

  // Unsaved work: ask before leaving the page (router) or closing the window (beforeunload).
  setLeaveCheck(() => !dirty || confirm("You have unsaved changes. Leave without saving them?"));
  window.addEventListener(
    "beforeunload",
    (event) => {
      if (dirty) event.preventDefault();
    },
    { signal },
  );

  appendAll(
    root,
    pageHeader(options.title, checkButton, saveButton, h("a", { class: "button", href: `#${options.cancelPath}` }, "Cancel")),
    options.note === undefined ? null : h("p", { class: "alert alert-info" }, options.note),
    messages,
    h(
      "div",
      { class: "palette" },
      h("span", { class: "muted" }, "Add:"),
      PALETTE.map((item) => {
        const button = h("button", { class: "gate-button", title: item.title }, item.label);
        button.addEventListener("click", () => addFromPalette(item.type));
        return button;
      }),
      h("span", { class: "spacer" }),
      arrange,
    ),
    h("div", { class: "editor" }, canvas, h("aside", { class: "editor-panel" }, circuitCard, selectionCard)),
  );
  redraw();
  renderSelectionCard();
}

function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}

function helpList(): HTMLElement {
  return h(
    "ul",
    { class: "help" },
    h("li", {}, "Add gates with the buttons above the drawing, then drag them where you like."),
    h("li", {}, "To connect two gates, drag from a gate's right dot (its output) to another gate's left dot (an input)."),
    h("li", {}, "Click a gate or a wire to select it. Delete removes it."),
    h("li", {}, "Every input dot needs exactly one wire. “Check” lists anything missing."),
    h("li", {}, "Ctrl+S saves."),
  );
}
