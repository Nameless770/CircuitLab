import type { CircuitListItem } from "@circuitlab/api-contract";
import type { Bit, Gate, Wire } from "@circuitlab/engine";
import type { LibraryItem, LocalCircuit } from "../../electron/bridge";
import { getCircuit } from "../api";
import { localBackend } from "../circuit/backend";
import { desktop, requireDesktop, unwrap } from "../desktop";
import type { Point } from "../diagram/geometry";
import { autoLayout } from "../diagram/layout";
import { positionsFor } from "../diagram/saved-positions";
import { sampleInputs, thumbnail } from "../diagram/thumb";
import { h } from "../dom";
import type { Example } from "../examples";
import { openLibraryCircuit } from "../offline/storage";
import { findLoop } from "../workspace/summary";

/**
 * The little pictures on the circuit cards. A list only says what a circuit is called, so each
 * picture loads its circuit when its card scrolls into view, and is kept for the next time (per
 * version of the circuit). The wires are lit by a simulation on this computer, with every other
 * input at 1, so a picture never adds a run to a circuit's history on the server.
 */
export interface ThumbData {
  readonly circuit: { readonly name: string; readonly gates: readonly Gate[]; readonly wires: readonly Wire[] };
  readonly positions: ReadonlyMap<string, Point>;
  readonly signals?: Readonly<Record<string, Bit>>;
}

const cache = new Map<string, Promise<ThumbData>>();

function remembered(key: string, load: () => Promise<ThumbData>): Promise<ThumbData> {
  let entry = cache.get(key);
  if (entry === undefined) {
    entry = load();
    cache.set(key, entry);
    entry.catch(() => cache.delete(key)); // a failure is tried again next time
  }
  return entry;
}

/** Lights the wires of a circuit for its picture (on this computer; nothing if that fails). */
async function lit(circuit: ThumbData["circuit"]): Promise<Readonly<Record<string, Bit>> | undefined> {
  if (desktop() === null) return undefined;
  try {
    const sequential = findLoop(circuit.gates, circuit.wires) !== null;
    const outcome = await localBackend({ name: circuit.name, gates: circuit.gates, wires: circuit.wires }).simulate({ inputs: sampleInputs(circuit.gates), mode: sequential ? "sequential" : "combinational" }, new AbortController().signal);
    return outcome.signals;
  } catch {
    return undefined;
  }
}

/** An example netlist, read once. */
export function exampleCircuit(example: Example): Promise<LocalCircuit> {
  return exampleCircuits.get(example.name) ?? readExample(example);
}

const exampleCircuits = new Map<string, Promise<LocalCircuit>>();

function readExample(example: Example): Promise<LocalCircuit> {
  const reading = requireDesktop()
    .parse(example.netlist)
    .then((result) => unwrap(result));
  exampleCircuits.set(example.name, reading);
  return reading;
}

export function exampleThumb(example: Example): Promise<ThumbData> {
  return remembered(`example:${example.name}`, async () => {
    const circuit = await exampleCircuit(example);
    return { circuit, positions: autoLayout(circuit.gates, circuit.wires), ...withSignals(await lit(circuit)) };
  });
}

export function libraryThumb(item: LibraryItem): Promise<ThumbData> {
  return remembered(`library:${item.id}@${item.updatedAt}`, async () => {
    const { circuit } = await openLibraryCircuit(item.id);
    return { circuit, positions: positionsFor(`library:${item.id}`, circuit.gates, circuit.wires), ...withSignals(await lit(circuit)) };
  });
}

export function serverThumb(item: CircuitListItem): Promise<ThumbData> {
  return remembered(`server:${item.id}@${item.version}`, async () => {
    const { circuit } = await getCircuit(item.id);
    return { circuit, positions: positionsFor(item.id, circuit.gates, circuit.wires), ...withSignals(await lit(circuit)) };
  });
}

function withSignals(signals: Readonly<Record<string, Bit>> | undefined): { signals?: Readonly<Record<string, Bit>> } {
  return signals === undefined ? {} : { signals };
}

/** Big circuits make a picture of dots: they get a note instead. */
const MAX_THUMB_GATES = 150;

/**
 * Fills `box` with the picture once it scrolls into view. `gates`: how many the circuit has, if
 * known already (a list says), so a big one needn't be loaded at all.
 */
export function lazyThumb(box: HTMLElement, load: () => Promise<ThumbData>, signal: AbortSignal, gates?: number): void {
  if (gates !== undefined && gates > MAX_THUMB_GATES) {
    box.replaceChildren(h("span", { class: "thumb-note" }, `${gates.toLocaleString()} gates`));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    observer.disconnect();
    load().then(
      (data) => {
        if (signal.aborted) return;
        box.replaceChildren(data.circuit.gates.length > MAX_THUMB_GATES ? h("span", { class: "thumb-note" }, `${data.circuit.gates.length.toLocaleString()} gates`) : thumbnail(data.circuit, data));
      },
      () => {
        if (!signal.aborted) box.replaceChildren(h("span", { class: "thumb-note" }, "No picture"));
      },
    );
  });
  observer.observe(box);
  signal.addEventListener("abort", () => observer.disconnect(), { once: true });
}
