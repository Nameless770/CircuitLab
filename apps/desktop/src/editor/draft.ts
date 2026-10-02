import type { CircuitInput } from "@circuitlab/api-contract";
import type { Bit, Gate, GateType, Wire } from "@circuitlab/engine";
import { PIN_RANGE, pinCounts, type Point } from "../diagram/geometry";

/**
 * The circuit being edited, and every change the editor can make to it, as plain functions on
 * plain data. The editor page only turns mouse and keyboard actions into calls to these, so the
 * rules can be unit tested without a browser (test/draft.test.ts).
 *
 * The functions change the draft in place. Those that can fail return an error message for the
 * user, or null when the change was made.
 */
export interface Draft {
  name: string;
  description: string;
  gates: Gate[];
  wires: Wire[];
  /** Input pins per gate id: chosen in the editor for AND, OR, ... (2 to 64). */
  pins: Map<string, number>;
  positions: Map<string, Point>;
}

export function emptyDraft(): Draft {
  return { name: "Untitled circuit", description: "", gates: [], wires: [], pins: new Map(), positions: new Map() };
}

/** A circuit from the server or from a file, ready to edit. */
export function draftFromCircuit(
  circuit: { readonly name: string; readonly description?: string; readonly gates: readonly Gate[]; readonly wires: readonly Wire[] },
  positions: Map<string, Point>,
): Draft {
  return {
    name: circuit.name,
    description: circuit.description ?? "",
    gates: [...circuit.gates],
    wires: [...circuit.wires],
    pins: pinCounts(circuit.gates, circuit.wires),
    positions,
  };
}

/** The draft as the API takes it (CircuitInput), ready to save. */
export function toCircuitInput(draft: Draft): CircuitInput {
  const description = draft.description.trim();
  return {
    name: draft.name.trim(),
    ...(description !== "" && { description }),
    gates: draft.gates,
    wires: draft.wires,
  };
}

/** The API's rule for gate ids (schema GateId in openapi.yaml). */
export const GATE_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.$[\]]*$/;

/** A free, readable id: A, B, C... for inputs, Y, Z... for outputs, and and1, or2... for the rest. */
export function nextGateId(type: GateType, taken: ReadonlySet<string>): string {
  const firstFree = (candidates: readonly string[], prefix: string): string => {
    const free = candidates.find((candidate) => !taken.has(candidate));
    if (free !== undefined) return free;
    for (let n = 1; ; n++) {
      if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
    }
  };
  if (type === "INPUT") return firstFree("ABCDEFGHIJKLMNOPQRSTUVWX".split(""), "in");
  if (type === "OUTPUT") return firstFree(["Y", "Z"], "out");
  return firstFree([], type.toLowerCase());
}

/** A gate object of the right shape for its type (only CONST gates have a value). */
function makeGate(id: string, type: GateType, value: Bit, label: string): Gate {
  const withLabel = label === "" ? {} : { label };
  return type === "CONST" ? { id, type, value, ...withLabel } : { id, type, ...withLabel };
}

export function addGate(draft: Draft, type: GateType, at: Point): Gate {
  const id = nextGateId(type, new Set(draft.gates.map((gate) => gate.id)));
  const gate = makeGate(id, type, 0, "");
  draft.gates.push(gate);
  draft.pins.set(id, PIN_RANGE[type].min);
  draft.positions.set(id, at);
  return gate;
}

/** Removes the gate and every wire connected to it. */
export function removeGate(draft: Draft, id: string): void {
  draft.gates = draft.gates.filter((gate) => gate.id !== id);
  draft.wires = draft.wires.filter((wire) => wire.from !== id && wire.to !== id);
  draft.pins.delete(id);
  draft.positions.delete(id);
}

export function renameGate(draft: Draft, oldId: string, newId: string): string | null {
  if (newId === oldId) return null;
  if (newId.length > 64 || !GATE_ID_PATTERN.test(newId)) {
    return "A gate name uses letters, digits and _ . $ [ ], doesn't start with a dot, and has at most 64 characters.";
  }
  if (draft.gates.some((gate) => gate.id === newId)) return `There is already a gate called "${newId}".`;
  draft.gates = draft.gates.map((gate) => (gate.id === oldId ? { ...gate, id: newId } : gate));
  draft.wires = draft.wires.map((wire) => ({
    ...wire,
    from: wire.from === oldId ? newId : wire.from,
    to: wire.to === oldId ? newId : wire.to,
  }));
  moveKey(draft.pins, oldId, newId);
  moveKey(draft.positions, oldId, newId);
  return null;
}

function moveKey<V>(map: Map<string, V>, oldKey: string, newKey: string): void {
  const value = map.get(oldKey);
  map.delete(oldKey);
  if (value !== undefined) map.set(newKey, value);
}

export function setLabel(draft: Draft, id: string, label: string): void {
  draft.gates = draft.gates.map((gate) => (gate.id === id ? makeGate(gate.id, gate.type, gate.type === "CONST" ? gate.value : 0, label.trim()) : gate));
}

export function setConstValue(draft: Draft, id: string, value: Bit): void {
  draft.gates = draft.gates.map((gate) => (gate.id === id && gate.type === "CONST" ? { ...gate, value } : gate));
}

/** Changes how many inputs an AND, OR, ... has. Wires on pins that disappear are removed. */
export function setPinCount(draft: Draft, id: string, count: number): void {
  const gate = draft.gates.find((candidate) => candidate.id === id);
  if (gate === undefined) return;
  const { min, max } = PIN_RANGE[gate.type];
  const pins = Math.min(max, Math.max(min, Math.round(count)));
  draft.pins.set(id, pins);
  draft.wires = draft.wires.filter((wire) => wire.to !== id || wire.toPin < pins);
}

/** Connects the output of `from` to input pin `toPin` of `to`. An input pin takes one wire, so a new wire replaces the old one. */
export function connect(draft: Draft, from: string, to: string, toPin: number): string | null {
  const source = draft.gates.find((gate) => gate.id === from);
  const target = draft.gates.find((gate) => gate.id === to);
  if (source === undefined || target === undefined) return "That gate doesn't exist any more.";
  if (source.type === "OUTPUT") return "An OUTPUT only shows a result; it can't drive other gates.";
  if (toPin < 0 || toPin >= (draft.pins.get(to) ?? 0)) return `${to} has no input pin ${toPin}.`;
  draft.wires = draft.wires.filter((wire) => !(wire.to === to && wire.toPin === toPin));
  draft.wires.push({ from, to, toPin });
  return null;
}

export function removeWire(draft: Draft, index: number): void {
  draft.wires = draft.wires.filter((_wire, i) => i !== index);
}
