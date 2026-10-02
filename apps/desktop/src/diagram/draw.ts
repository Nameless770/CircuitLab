import type { Bit, Gate, GateType, Wire } from "@circuitlab/engine";
import { s } from "../dom";
import { PIN_LENGTH, add, gateSize, inputPinPoint, outputPinPoint, type Point } from "./geometry";

/**
 * Draws a circuit as SVG: standard logic-gate symbols, wires as curves, and (after a simulation)
 * wires coloured by their value.
 *
 * Every gate, pin and wire gets data-* attributes (data-gate="carry", data-pin="in",
 * data-index="1", data-wire="3"). Pages don't attach listeners to each element; they listen on
 * the whole <svg> and read those attributes from the clicked element ("event delegation"). That's
 * why this file can redraw everything from scratch whenever something changes.
 */

export interface DiagramModel {
  readonly gates: readonly Gate[];
  readonly wires: readonly Wire[];
  readonly positions: ReadonlyMap<string, Point>;
  /** Input pins per gate id. */
  readonly pins: ReadonlyMap<string, number>;
}

export interface DiagramView {
  /** Every gate's output value, from a simulation. Wires, switches and lamps are coloured from it. */
  readonly signals?: Readonly<Record<string, Bit>>;
  /** The circuit page: INPUT gates are switches to click. */
  readonly clickableInputs?: boolean;
  /** The editor: bigger pins to grab, selection, gates the last check complained about. */
  readonly editing?: boolean;
  readonly selectedGate?: string | null;
  readonly selectedWire?: number | null;
  readonly problemGates?: ReadonlySet<string>;
  /** The drawing is at least this big (the editor wants room to add gates). */
  readonly minWidth?: number;
  readonly minHeight?: number;
}

export function drawDiagram(svg: SVGSVGElement, model: DiagramModel, view: DiagramView = {}): void {
  const gatesById = new Map(model.gates.map((gate) => [gate.id, gate]));
  const pinsOf = (id: string): number => model.pins.get(id) ?? 0;
  const positionOf = (id: string): Point => model.positions.get(id) ?? { x: 0, y: 0 };

  // Wires first, so gates are drawn on top of them.
  const wireLayer = s("g", { class: "wires" });
  model.wires.forEach((wire, index) => {
    const from = gatesById.get(wire.from);
    const to = gatesById.get(wire.to);
    if (from === undefined || to === undefined) return;
    const start = add(positionOf(from.id), outputPinPoint(from.type, pinsOf(from.id)));
    const end = add(positionOf(to.id), inputPinPoint(to.type, pinsOf(to.id), wire.toPin));
    const value = view.signals?.[wire.from];
    const classes = ["wire", value === 1 ? "on" : value === 0 ? "off" : "", view.selectedWire === index ? "selected" : ""];
    const path = wirePath(start, end);
    wireLayer.append(
      s(
        "g",
        { class: classes.join(" ").trim(), "data-wire": index },
        s("title", {}, `${wire.from} → ${wire.to} (pin ${wire.toPin})`),
        // A wide invisible copy of the line, so a thin wire is still easy to click.
        s("path", { d: path, class: "wire-hit" }),
        s("path", { d: path, class: "wire-line" }),
      ),
    );
  });

  const gateLayer = s("g", { class: "gates" });
  let right = view.minWidth ?? 0;
  let bottom = view.minHeight ?? 0;
  for (const gate of model.gates) {
    const at = positionOf(gate.id);
    const pins = pinsOf(gate.id);
    gateLayer.append(drawGate(gate, pins, at, view));
    const { width, height } = gateSize(gate.type, pins);
    right = Math.max(right, at.x + width + PIN_LENGTH + 60);
    bottom = Math.max(bottom, at.y + height + 50);
  }

  // The editor draws its "wire being dragged" in this layer.
  const overlay = s("g", { class: "overlay" });
  svg.replaceChildren(wireLayer, gateLayer, overlay);
  svg.setAttribute("width", String(Math.ceil(right)));
  svg.setAttribute("height", String(Math.ceil(bottom)));
  svg.setAttribute("viewBox", `0 0 ${Math.ceil(right)} ${Math.ceil(bottom)}`);
}

/** A smooth curve leaving the output pin to the right and arriving at the input pin from the left. */
export function wirePath(start: Point, end: Point): string {
  const bend = Math.max(30, Math.abs(end.x - start.x) / 2);
  return `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`;
}

function drawGate(gate: Gate, pins: number, at: Point, view: DiagramView): SVGGElement {
  const { width, height } = gateSize(gate.type, pins);
  const value = view.signals?.[gate.id];
  const classes = [
    "gate",
    `gate-${gate.type.toLowerCase()}`,
    value === 1 ? "high" : "",
    view.selectedGate === gate.id ? "selected" : "",
    view.problemGates?.has(gate.id) === true ? "problem" : "",
    view.clickableInputs === true && gate.type === "INPUT" ? "clickable" : "",
  ];
  const group = s("g", {
    class: classes.join(" ").replace(/\s+/g, " ").trim(),
    transform: `translate(${at.x} ${at.y})`,
    "data-gate": gate.id,
    "data-type": gate.type,
  });
  group.append(s("title", {}, describeGate(gate)));

  for (let index = 0; index < pins; index++) {
    const pin = inputPinPoint(gate.type, pins, index);
    group.append(s("line", { x1: pin.x, y1: pin.y, x2: bodyLeftEdge(gate.type, width, height, pin.y), y2: pin.y, class: "pin-line" }));
    group.append(pinCircle(pin, "in", index, view.editing === true));
  }
  if (gate.type !== "OUTPUT") {
    const pin = outputPinPoint(gate.type, pins);
    group.append(s("line", { x1: width, y1: pin.y, x2: pin.x, y2: pin.y, class: "pin-line" }));
    group.append(pinCircle(pin, "out", 0, view.editing === true));
  }

  group.append(...gateBody(gate, width, height, value));
  group.append(s("text", { x: width / 2, y: height + 15, class: "gate-name" }, shorten(gate.id)));
  return group;
}

function pinCircle(at: Point, side: "in" | "out", index: number, editing: boolean): SVGElement {
  const data = { "data-pin": side, "data-index": index };
  if (!editing) return s("circle", { cx: at.x, cy: at.y, r: 2.5, class: "pin" });
  // In the editor: a visible dot plus a bigger invisible circle that's easy to grab.
  return s(
    "g",
    { class: `pin-handle pin-${side}` },
    s("circle", { cx: at.x, cy: at.y, r: 10, class: "pin-hit", ...data }),
    s("circle", { cx: at.x, cy: at.y, r: 4, class: "pin", ...data }),
  );
}

/** The symbol of each gate type, drawn in a box `width` x `height`. */
function gateBody(gate: Gate, width: number, height: number, value: Bit | undefined): SVGElement[] {
  const valueText = value === undefined ? null : String(value);
  switch (gate.type) {
    case "INPUT":
      return [
        s("rect", { x: 0, y: 0, width, height, rx: 7, class: "body" }),
        s("text", { x: width / 2, y: height / 2, class: "gate-value" }, valueText ?? "IN"),
      ];
    case "OUTPUT":
      return [
        s("circle", { cx: width / 2, cy: height / 2, r: width / 2, class: "body" }),
        s("text", { x: width / 2, y: height / 2, class: "gate-value" }, valueText ?? "OUT"),
      ];
    case "CONST":
      return [
        s("rect", { x: 0, y: 0, width, height, rx: 4, class: "body" }),
        s("text", { x: width / 2, y: height / 2, class: "gate-value" }, String(gate.value)),
      ];
    default:
      return logicGateBody(gate.type, width, height);
  }
}

function logicGateBody(type: GateType, width: number, height: number): SVGElement[] {
  const inverted = type === "NOT" || type === "NAND" || type === "NOR" || type === "XNOR";
  const w = inverted ? width - 8 : width; // leave room for the little circle ("bubble") that means "inverted"
  const h = height;
  const shapes: SVGElement[] = [];
  switch (type) {
    case "BUF":
    case "NOT":
      shapes.push(s("path", { d: `M 0 0 L ${w} ${h / 2} L 0 ${h} Z`, class: "body" }));
      break;
    case "AND":
    case "NAND":
      shapes.push(s("path", { d: `M 0 0 H ${w / 2} A ${w / 2} ${h / 2} 0 0 1 ${w / 2} ${h} H 0 Z`, class: "body" }));
      break;
    default: // OR, NOR, XOR, XNOR
      shapes.push(s("path", { d: `M 0 0 Q ${w * 0.6} 0 ${w} ${h / 2} Q ${w * 0.6} ${h} 0 ${h} Q ${w * 0.25} ${h / 2} 0 0 Z`, class: "body" }));
      if (type === "XOR" || type === "XNOR") {
        shapes.push(s("path", { d: `M -6 0 Q ${w * 0.25 - 6} ${h / 2} -6 ${h}`, class: "body-line" }));
      }
  }
  if (inverted) shapes.push(s("circle", { cx: width - 4, cy: h / 2, r: 4, class: "body" }));
  return shapes;
}

/** Where an input pin's line meets the gate's body (OR-type gates have a curved back). */
function bodyLeftEdge(type: GateType, width: number, height: number, y: number): number {
  if (type === "OR" || type === "NOR" || type === "XOR" || type === "XNOR") {
    const w = type === "NOR" || type === "XNOR" ? width - 8 : width;
    const t = y / height; // the back curve is a quadratic Bézier, so its x at height y is 0.5·w·t·(1−t)
    return (type === "XOR" || type === "XNOR" ? -6 : 0) + 0.5 * w * t * (1 - t);
  }
  return 0;
}

export function describeGate(gate: Gate): string {
  const label = gate.label === undefined ? "" : ` (${gate.label})`;
  return `${gate.id}${label}: ${gate.type}${gate.type === "CONST" ? ` ${gate.value}` : ""}`;
}

function shorten(text: string): string {
  return text.length > 14 ? `${text.slice(0, 13)}…` : text;
}
