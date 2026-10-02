import type { Gate, Wire } from "@circuitlab/engine";
import type { Point } from "./geometry";
import { autoLayout } from "./layout";

/**
 * Where you dragged the gates in the editor, remembered in this browser (localStorage).
 *
 * Known shortcut: the API has no field for gate positions, and I didn't want to change the
 * API for the app. So positions stay on this computer, and the same circuit opened somewhere
 * else is arranged automatically (layout.ts). The proper fix is optional `x`/`y` fields on gates
 * in the API (an additive change, so it fits in /v1); see docs/desktop-app.md.
 */

const PREFIX = "circuitlab.positions.";

/** The saved positions if every gate has one; otherwise the automatic layout. */
export function positionsFor(circuitId: string, gates: readonly Gate[], wires: readonly Wire[]): Map<string, Point> {
  return savedPositions(circuitId, gates) ?? autoLayout(gates, wires);
}

function savedPositions(circuitId: string, gates: readonly Gate[]): Map<string, Point> | null {
  try {
    const text = localStorage.getItem(PREFIX + circuitId);
    if (text === null) return null;
    const saved = JSON.parse(text) as Record<string, Point | undefined>;
    // If some gate has no saved position, the circuit was changed somewhere else (say, as a
    // netlist). Mixing old positions with new ones could stack gates on top of each other, so
    // start over with the automatic layout instead.
    const positions = new Map<string, Point>();
    for (const gate of gates) {
      const point = saved[gate.id];
      if (point === undefined || typeof point.x !== "number" || typeof point.y !== "number") return null;
      positions.set(gate.id, { x: point.x, y: point.y });
    }
    return positions;
  } catch {
    return null; // storage blocked or corrupted: just use the automatic layout
  }
}

export function savePositions(circuitId: string, positions: ReadonlyMap<string, Point>): void {
  try {
    localStorage.setItem(PREFIX + circuitId, JSON.stringify(Object.fromEntries(positions)));
  } catch {
    // Storage full or blocked: the diagram falls back to the automatic layout next time.
  }
}

export function forgetPositions(circuitId: string): void {
  try {
    localStorage.removeItem(PREFIX + circuitId);
  } catch {
    // nothing to clean up then
  }
}
