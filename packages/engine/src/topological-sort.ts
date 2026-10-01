import { CycleError } from "./errors";
import { MinHeap } from "./internal/min-heap";
import { at } from "./internal/util";
import type { Circuit } from "./types";

/**
 * Orders gate ids so that every gate comes after all the gates that drive it (Kahn's algorithm).
 *
 * Deterministic: when several gates are ready at once, the one declared first goes next.
 * A circuit whose gates are already listed in a valid order therefore comes back unchanged.
 * Runs in O((V + E) log V) for V gates and E wires.
 *
 * Expects a valid circuit (see `validateCircuit`); `compileCircuit` handles both steps.
 *
 * @throws CycleError naming the gates around a feedback loop, e.g. `q -> qbar -> q`
 */
export function topologicalSort(circuit: Circuit): string[] {
  const { gates, wires } = circuit;
  const indexOf = indexGates(circuit);

  // Gates are handled by declaration index from here on.
  const successors: number[][] = gates.map(() => []);
  const pendingInputs: number[] = gates.map(() => 0); // in-degree: wires from gates not yet ordered
  for (const wire of wires) {
    const from = indexOf(wire.from);
    const to = indexOf(wire.to);
    at(successors, from).push(to);
    pendingInputs[to] = at(pendingInputs, to) + 1;
  }

  // A gate is ready once nothing it depends on is still pending. Initially that is every
  // gate without inputs (in a valid circuit: the INPUT and CONST gates).
  const ready = new MinHeap();
  pendingInputs.forEach((count, gate) => {
    if (count === 0) ready.push(gate);
  });

  const order: number[] = [];
  for (let gate = ready.pop(); gate !== undefined; gate = ready.pop()) {
    order.push(gate);
    for (const next of at(successors, gate)) {
      const remaining = at(pendingInputs, next) - 1;
      pendingInputs[next] = remaining;
      if (remaining === 0) ready.push(next);
    }
  }

  // Gates on (or downstream of) a loop never become ready, so they are missing from `order`.
  if (order.length < gates.length) {
    throw new CycleError(findCycle(circuit, indexOf, pendingInputs));
  }
  return order.map((gate) => at(gates, gate).id);
}

function indexGates(circuit: Circuit): (id: string) => number {
  const indexById = new Map<string, number>();
  circuit.gates.forEach((gate, index) => {
    if (indexById.has(gate.id)) throw contractError(`duplicate gate id "${gate.id}"`);
    indexById.set(gate.id, index);
  });
  return (id) => {
    const index = indexById.get(id);
    if (index === undefined) throw contractError(`a wire references unknown gate "${id}"`);
    return index;
  };
}

/** Misuse of the API (skipping validation) is a bug in the caller, not a problem with the circuit. */
function contractError(detail: string): Error {
  return new Error(`topologicalSort expects a validated circuit, but ${detail}. Run validateCircuit first.`);
}

/**
 * Recovers one concrete loop after Kahn's algorithm gets stuck.
 *
 * Every stuck gate still has a pending input, and that input comes from another stuck gate.
 * So starting anywhere among the stuck gates and repeatedly stepping back to a stuck driver
 * never dead-ends. With finitely many gates the walk must eventually revisit one, and the
 * stretch between the two visits is a cycle. This walk is O(V + E) and needs no recursion.
 */
function findCycle(circuit: Circuit, indexOf: (id: string) => number, pendingInputs: readonly number[]): string[] {
  const isStuck = (gate: number): boolean => at(pendingInputs, gate) > 0;

  // Drivers of each gate, in wire order. Only needed on this error path, so built lazily.
  const drivers: number[][] = circuit.gates.map(() => []);
  for (const wire of circuit.wires) at(drivers, indexOf(wire.to)).push(indexOf(wire.from));

  const walk: number[] = [];
  const visited = new Set<number>();
  let gate = pendingInputs.findIndex((count) => count > 0);
  while (!visited.has(gate)) {
    visited.add(gate);
    walk.push(gate);
    const driver = at(drivers, gate).find(isStuck);
    if (driver === undefined) throw new Error("Internal error: a stuck gate has no stuck driver");
    gate = driver;
  }

  // The walk followed wires backwards, so reverse the looping part to get signal-flow order.
  const loop = walk.slice(walk.indexOf(gate)).reverse();

  // Start at the earliest-declared gate so the same circuit always gives the same message.
  let first = 0;
  loop.forEach((member, position) => {
    if (member < at(loop, first)) first = position;
  });
  const rotated = [...loop.slice(first), ...loop.slice(0, first)];
  return [...rotated, at(rotated, 0)].map((member) => at(circuit.gates, member).id);
}
