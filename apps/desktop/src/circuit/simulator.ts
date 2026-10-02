import type { Bit } from "@circuitlab/engine";
import { h, s } from "../dom";
import { drawDiagram } from "../diagram/draw";
import { pinCounts } from "../diagram/geometry";
import { positionsFor } from "../diagram/saved-positions";
import { errorBox } from "../ui";
import type { CircuitBackend, SimulationOutcome, ViewableCircuit } from "./backend";

/** Bigger circuits aren't drawn: thousands of gates make an unreadable, slow picture. */
export const MAX_DRAWN_GATES = 400;

/**
 * "Try it": the diagram with clickable input switches, the outputs, and the wires coloured by
 * their values. Every click asks the backend (the API, or the main process offline) to simulate.
 *
 * Circuits with a feedback loop (latches) are simulated in sequential mode: each step sends the
 * `state` the previous step returned, which is how the circuit "remembers".
 */
export function simulatorSection(circuit: ViewableCircuit, backend: CircuitBackend, positionsKey: string, signal: AbortSignal): HTMLElement {
  const sequential = circuit.summary.feedbackLoop !== null;
  const inputs: Record<string, Bit> = Object.fromEntries(circuit.summary.inputs.map((id) => [id, 0 as Bit]));
  let state: Readonly<Record<string, Bit>> | undefined;
  let last: SimulationOutcome | null = null;

  const drawn = circuit.gates.length <= MAX_DRAWN_GATES;
  const svg = s("svg", { class: "circuit-diagram", role: "img", "aria-label": `Diagram of ${circuit.name}` });
  const model = { gates: circuit.gates, wires: circuit.wires, pins: pinCounts(circuit.gates, circuit.wires), positions: positionsFor(positionsKey, circuit.gates, circuit.wires) };
  const labels = new Map(circuit.gates.map((gate) => [gate.id, gate.label]));

  const inputList = h("div", { class: "io-list" });
  const outputList = h("div", { class: "io-list" });
  const status = h("div", { class: "sim-status", "aria-live": "polite" });
  const stateLine = h("div", { class: "sim-status" });

  function redraw(): void {
    if (drawn) drawDiagram(svg, model, { ...(last !== null && { signals: last.signals }), clickableInputs: true });
    inputList.replaceChildren(
      ...circuit.summary.inputs.map((id) => {
        const on = inputs[id] === 1;
        const button = h("button", { class: "switch", "aria-pressed": on ? "true" : "false", title: `Turn ${id} ${on ? "off" : "on"}` }, on ? "1" : "0");
        button.addEventListener("click", () => toggle(id));
        return h("div", { class: "io-row" }, ioName(id, labels.get(id)), button);
      }),
    );
    outputList.replaceChildren(
      ...circuit.summary.outputs.map((id) => {
        const value = last?.outputs[id];
        return h("div", { class: "io-row" }, ioName(id, labels.get(id)), h("span", { class: value === 1 ? "lamp on" : "lamp" }, value === undefined ? "–" : String(value)));
      }),
    );
    if (sequential) {
      const remembered = state === undefined ? "nothing yet (every gate starts at 0)" : Object.entries(state).map(([id, value]) => `${id}=${value}`).join(", ");
      stateLine.textContent = `Remembers: ${remembered}`;
    }
  }

  function toggle(id: string): void {
    inputs[id] = inputs[id] === 1 ? 0 : 1;
    redraw();
    run();
  }

  // Steps run one after another, never at the same time: in sequential mode each step needs the
  // state the previous one returned, and quick clicks must not overtake each other.
  let queue: Promise<void> = Promise.resolve();
  function run(): void {
    queue = queue.then(step);
  }

  async function step(): Promise<void> {
    try {
      const outcome = await backend.simulate(
        { inputs: { ...inputs }, mode: sequential ? "sequential" : "combinational", ...(sequential && state !== undefined && { state }) },
        signal,
      );
      last = outcome;
      state = outcome.state;
      status.replaceChildren(
        outcome.fromCache === undefined
          ? "Simulated on this computer."
          : outcome.fromCache
            ? "Answered from the server's cache: this exact question was asked before."
            : "Simulated by the server.",
      );
    } catch (error) {
      if (signal.aborted) return;
      last = null;
      status.replaceChildren(errorBox(error));
    }
    redraw();
  }

  // Clicking a switch in the drawing works like the buttons in the panel.
  svg.addEventListener("click", (event) => {
    const gate = (event.target as Element).closest("[data-type='INPUT']");
    const id = gate?.getAttribute("data-gate");
    if (id !== null && id !== undefined) toggle(id);
  });

  const reset = h("button", { class: "small", title: "Forget what the circuit remembers and set every input to 0" }, "Reset");
  reset.addEventListener("click", () => {
    for (const id of Object.keys(inputs)) inputs[id] = 0;
    state = undefined;
    redraw();
    run();
  });

  redraw();
  run(); // the first step, with every input at 0

  return h(
    "section",
    { class: "card section" },
    h("h2", {}, "Try it", sequential ? h("span", { class: "badge loop", title: "It has a feedback loop" }, "remembers state") : null),
    sequential
      ? h(
          "p",
          { class: "muted" },
          `This circuit has a feedback loop (${circuit.summary.feedbackLoop?.join(" → ") ?? ""}), so it's simulated step by step: each click is one step, and the loop remembers its value between steps.`,
        )
      : h("p", { class: "muted" }, "Click the inputs (in the drawing or on the right) to switch them between 0 and 1. Green wires carry a 1."),
    h(
      "div",
      { class: "simulator" },
      drawn
        ? h("div", { class: "diagram" }, svg)
        : h("p", { class: "alert alert-info" }, `This circuit has ${circuit.gates.length.toLocaleString()} gates, too many to draw. You can still set its inputs on the right.`),
      h(
        "div",
        { class: "io-panel" },
        h("div", {}, h("h3", {}, "Inputs"), circuit.summary.inputs.length === 0 ? h("p", { class: "muted" }, "None.") : inputList),
        h("div", {}, h("h3", {}, "Outputs"), circuit.summary.outputs.length === 0 ? h("p", { class: "muted" }, "None.") : outputList),
        sequential ? h("div", {}, stateLine, reset) : null,
        status,
      ),
    ),
  );
}

function ioName(id: string, label: string | undefined): HTMLElement {
  return h("span", { class: "io-name", title: id }, id, label === undefined ? null : h("span", { class: "io-label" }, ` ${label}`));
}
