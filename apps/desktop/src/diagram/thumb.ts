import type { Bit, Gate, Wire } from "@circuitlab/engine";
import { s } from "../dom";
import { drawDiagram } from "./draw";
import { pinCounts, type Point } from "./geometry";
import { autoLayout } from "./layout";

/**
 * A small picture of a circuit that fills its box: for the cards on the home screen and in the
 * lists, and the assistant's draft. No names, no tooltips, nothing to click. With `signals`, the
 * wires carrying a 1 are lit (and, with `flow`, show the signal moving).
 */
export function thumbnail(
  circuit: { readonly name: string; readonly gates: readonly Gate[]; readonly wires: readonly Wire[] },
  options: { readonly positions?: ReadonlyMap<string, Point>; readonly signals?: Readonly<Record<string, Bit>>; readonly flow?: boolean; readonly full?: boolean } = {},
): SVGSVGElement {
  const svg = s("svg", { class: "circuit-diagram", role: "img", "aria-label": `Diagram of ${circuit.name}` });
  drawDiagram(
    svg,
    { gates: circuit.gates, wires: circuit.wires, pins: pinCounts(circuit.gates, circuit.wires), positions: options.positions ?? autoLayout(circuit.gates, circuit.wires) },
    { fit: true, thumb: options.full !== true, flow: options.flow === true, ...(options.signals !== undefined && { signals: options.signals }) },
  );
  return svg;
}

/**
 * Input values that show something on a thumbnail: every other input at 1. All zeros would
 * leave most circuits dark.
 */
export function sampleInputs(gates: readonly Gate[]): Record<string, Bit> {
  return Object.fromEntries(gates.filter((gate) => gate.type === "INPUT").map((gate, index) => [gate.id, index % 2 === 0 ? 1 : 0]));
}
