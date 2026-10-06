import type { GateType } from "@circuitlab/engine";
import { drawDiagram, drawingSize, gateIcon, wirePath, type DiagramModel } from "../diagram/draw";
import { PIN_LENGTH, add, inputPinPoint, outputPinPoint, type Point } from "../diagram/geometry";
import { autoLayout } from "../diagram/layout";
import { savePositions } from "../diagram/saved-positions";
import { h, s } from "../dom";
import { addGate, connect, removeGate, removeWire } from "../editor/draft";
import { toast } from "../shell/toast";
import type { Ws } from "./context";
import { drawingChanged, positionsKeyOf } from "./store";

/** Bigger circuits aren't drawn: thousands of gates make an unreadable, slow picture. */
export const MAX_DRAWN_GATES = 400;

/** Gates snap to this grid while dragged, which keeps drawings tidy. */
const GRID = 10;

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

export interface Canvas {
  /** What goes in the stage: the scrolling drawing and the things floating over it. */
  readonly nodes: readonly HTMLElement[];
  /** Draws the circuit again (after a change, or a new simulation). */
  redraw(): void;
  /** Picks the zoom that shows the whole circuit. */
  fit(): void;
  zoomBy(factor: number): void;
  deleteSelection(): void;
  arrange(): void;
  /** Escape: drops a wire being dragged. */
  cancelDrag(): void;
  /** Stops listening to the mouse and the window's size: the canvas is being replaced. */
  dispose(): void;
}

export interface CanvasActions {
  /** Simulate mode: an input in the drawing was clicked. */
  toggleInput(id: string): void;
  /** Draw mode: the circuit changed (gates or wires). */
  edited(): void;
  /** Draw mode: the selection changed. */
  selected(): void;
}

export function createCanvas(ws: Ws, actions: CanvasActions): Canvas {
  const { doc } = ws;
  // This canvas's own lifetime: it ends when the workspace goes away, or when the canvas is replaced (another mode).
  const life = new AbortController();
  ws.signal.addEventListener("abort", () => life.abort(), { once: true });
  const signal = life.signal;
  const drawing = doc.mode === "draw";
  const svg = s("svg", { class: drawing ? "circuit-diagram editing" : "circuit-diagram" });
  const inner = h("div", { class: "canvas-inner" }, svg);
  const scroller = h("div", { class: drawing ? "canvas drawing" : "canvas" }, inner);
  const zoomLabel = h("span", { class: "zoom-label" });
  // Shown while a drawing has no gates (redraw hides it once the first one is added).
  const emptyNote = h(
    "div",
    { class: "canvas-note" },
    h("div", {}, h("strong", {}, "An empty canvas"), "Add gates from the palette on the left, then drag from a gate's right dot to another gate's left dot to wire them."),
  );
  const tooBig = doc.draft.gates.length > MAX_DRAWN_GATES;
  let drag: Drag | null = null;
  // The open circuit's zoom is null until you choose one yourself: the drawing then keeps fitting
  // its area (which settles as the truth table below it loads, and changes with the window).
  let fitted = 1;

  const model = (): DiagramModel => ({ gates: doc.draft.gates, wires: doc.draft.wires, pins: doc.draft.pins, positions: doc.draft.positions });
  const zoom = (): number => doc.zoom ?? fitted;

  function redraw(): void {
    if (tooBig) return;
    const z = zoom();
    const selection = ws.selection;
    drawDiagram(svg, model(), {
      ...(ws.last !== null && { signals: ws.last.signals }),
      clickableInputs: !drawing,
      editing: drawing,
      selectedGate: selection?.kind === "gate" ? selection.id : null,
      selectedWire: selection?.kind === "wire" ? selection.index : null,
      problemGates: ws.problemGates,
      flow: !drawing,
      zoom: z,
      // While drawing, the picture fills the window, so empty space can be clicked and gates placed there.
      ...(drawing && { minWidth: Math.max(0, scroller.clientWidth - 144) / z, minHeight: Math.max(0, scroller.clientHeight - 4) / z }),
    });
    scroller.style.setProperty("--grid-size", `${20 * z}px ${20 * z}px`);
    zoomLabel.textContent = `${Math.round(z * 100)}%`;
    emptyNote.hidden = !drawing || doc.draft.gates.length > 0;
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

  /** Picks the zoom that shows the whole circuit, while no zoom was chosen. */
  function fitIfAuto(): void {
    if (doc.zoom !== null) {
      redraw();
      return;
    }
    if (scroller.clientWidth === 0) return; // not on screen yet
    const size = drawingSize(model());
    const width = scroller.clientWidth - 80 - (drawing ? 140 : 0);
    const height = scroller.clientHeight - 80;
    fitted = Math.round(Math.max(0.35, Math.min(1.7, Math.min(width / size.width, height / size.height))) * 20) / 20;
    redraw();
  }

  /** Fit, and keep fitting when the area changes (the Fit button, F, Arrange). */
  function fit(): void {
    doc.zoom = null;
    fitIfAuto();
  }

  function zoomBy(factor: number): void {
    doc.zoom = Math.max(0.4, Math.min(2.5, Math.round(zoom() * factor * 20) / 20));
    redraw();
  }

  // ---- the mouse ---------------------------------------------------------------------------------

  /** Mouse position in the drawing's own coordinates (works at any zoom). */
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
    const at = doc.draft.positions.get(ref.gate) ?? { x: 0, y: 0 };
    const gate = doc.draft.gates.find((candidate) => candidate.id === ref.gate);
    if (gate === undefined) return at;
    const pins = doc.draft.pins.get(ref.gate) ?? 0;
    return add(at, ref.side === "out" ? outputPinPoint(gate.type, pins) : inputPinPoint(gate.type, pins, ref.index));
  }

  function select(next: Ws["selection"]): void {
    ws.selection = next;
    ws.nameError = null;
    redraw();
    actions.selected();
  }

  /** Gate positions aren't part of the circuit (a netlist has none), so they're kept on this computer at once. */
  function keepPositions(): void {
    savePositions(positionsKeyOf(doc.source), doc.draft.positions);
  }

  if (drawing) {
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
        const at = doc.draft.positions.get(gateId) ?? { x: 0, y: 0 };
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
    // ends properly. `signal` removes these listeners when the workspace goes away.
    window.addEventListener(
      "pointermove",
      (event) => {
        if (drag === null) return;
        const point = svgPoint(event);
        if (drag.kind === "move") {
          const x = Math.max(PIN_LENGTH + 6, snap(point.x - drag.grabOffset.x));
          const y = Math.max(6, snap(point.y - drag.grabOffset.y));
          doc.draft.positions.set(drag.id, { x, y });
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
          if (finished.moved) keepPositions();
          return;
        }
        finished.line.remove();
        const end = pinAt(document.elementFromPoint(event.clientX, event.clientY));
        if (end === null || (end.gate === finished.from.gate && end.side === finished.from.side && end.index === finished.from.index)) return;
        if (end.side === finished.from.side) {
          toast("Connect an output (the dot on a gate's right side) to an input (a dot on a gate's left side).", { error: true });
          return;
        }
        const [output, input] = finished.from.side === "out" ? [finished.from, end] : [end, finished.from];
        if (output.gate === input.gate) {
          toast("A gate can't feed its own input.", { error: true });
          return;
        }
        const error = connect(doc.draft, output.gate, input.gate, input.index);
        if (error !== null) {
          toast(error, { error: true });
          return;
        }
        changed();
      },
      { signal },
    );
  } else {
    // Clicking a switch in the drawing works like the switches in the inspector.
    svg.addEventListener("click", (event) => {
      const id = (event.target as Element).closest("[data-type='INPUT']")?.getAttribute("data-gate");
      if (id !== null && id !== undefined) actions.toggleInput(id);
    });
  }

  /** After every change to the gates or wires. */
  function changed(): void {
    ws.problemGates = new Set(); // the last check's complaints may not apply any more
    ws.drawCheck = null;
    drawingChanged(doc);
    redraw();
    actions.edited();
  }

  function deleteSelection(): void {
    const selection = ws.selection;
    if (selection === null) return;
    if (selection.kind === "gate") removeGate(doc.draft, selection.id);
    else removeWire(doc.draft, selection.index);
    ws.selection = null;
    changed();
    actions.selected();
  }

  function arrange(): void {
    doc.draft.positions = autoLayout(doc.draft.gates, doc.draft.wires);
    keepPositions();
    fit();
  }

  function addFromPalette(type: GateType): void {
    const gate = addGate(doc.draft, type, freeSpot(type));
    ws.selection = { kind: "gate", id: gate.id };
    changed();
    actions.selected();
  }

  /**
   * A spot in the visible part of the drawing that no gate is using. Like the automatic layout,
   * inputs start on the left, outputs on the right, and the other gates in between.
   */
  function freeSpot(type: GateType): Point {
    const z = zoom();
    const column = type === "INPUT" || type === "CONST" ? 0 : type === "OUTPUT" ? 2 : 1;
    const left = snap(scroller.scrollLeft / z + 60 + column * 180);
    const top = snap(scroller.scrollTop / z + 40);
    const used = [...doc.draft.positions.values()];
    const taken = (spot: Point): boolean => used.some((other) => Math.abs(other.x - spot.x) < 80 && Math.abs(other.y - spot.y) < 56);
    let spot = { x: left, y: top };
    const bottom = top + Math.max(300, scroller.clientHeight / z - 100);
    for (let tries = 0; tries < 300 && taken(spot); tries++) spot = spot.y + 70 > bottom ? { x: spot.x + 130, y: top } : { x: spot.x, y: spot.y + 70 };
    return spot;
  }

  // ---- what floats over the drawing --------------------------------------------------------------

  const nodes: HTMLElement[] = [scroller];
  if (tooBig) {
    nodes.push(
      h(
        "div",
        { class: "canvas-note" },
        h("div", {}, h("strong", {}, "Too big to draw"), `This circuit has ${doc.draft.gates.length.toLocaleString()} gates, too many to draw readably. You can still set its inputs on the right, and edit it as a netlist.`),
      ),
    );
  } else if (drawing) {
    const palette = h("div", { class: "gate-palette", role: "toolbar", "aria-label": "Add gates" }, h("div", { class: "label" }, "Add"));
    for (const item of PALETTE) {
      const button = h("button", { type: "button", class: "gate-button", title: item.title }, gateIcon(item.type), h("span", {}, item.label));
      button.addEventListener("click", () => addFromPalette(item.type));
      palette.append(button);
    }
    const arrangeButton = h("button", { type: "button", class: "arrange", title: "Place every gate automatically, left to right (A)" }, "Arrange");
    arrangeButton.addEventListener("click", arrange);
    palette.append(h("div", { class: "spacer" }), arrangeButton);
    nodes.push(palette, emptyNote);
  } else {
    nodes.push(
      h(
        "div",
        { class: "legend" },
        h("span", {}, h("span", { class: "swatch on" }), "1"),
        h("span", {}, h("span", { class: "swatch" }), "0"),
        h("span", { class: "faint" }, "|"),
        h("span", {}, "Click an input, or press its number"),
      ),
    );
  }
  if (!tooBig) {
    const zoomButton = (label: string, title: string, run: () => void, extra = ""): HTMLButtonElement => {
      const button = h("button", { type: "button", title, class: extra || null, "aria-label": title }, label);
      button.addEventListener("click", run);
      return button;
    };
    nodes.push(
      h(
        "div",
        { class: "zoom" },
        zoomButton("−", "Zoom out (−)", () => zoomBy(1 / 1.15)),
        zoomLabel,
        zoomButton("+", "Zoom in (+)", () => zoomBy(1.15)),
        zoomButton("Fit", "Fit to window (F)", fit, "fit"),
      ),
    );
  }

  // Fill the window again when it's resized (and fit the circuit while no zoom was chosen).
  const resize = new ResizeObserver(fitIfAuto);
  resize.observe(scroller);
  signal.addEventListener("abort", () => resize.disconnect(), { once: true });

  redraw();
  return {
    nodes,
    redraw,
    fit,
    zoomBy,
    deleteSelection,
    arrange,
    cancelDrag() {
      if (drag?.kind === "wire") drag.line.remove();
      drag = null;
    },
    dispose() {
      life.abort();
      cancelAnimationFrame(frame);
    },
  };
}

function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}
