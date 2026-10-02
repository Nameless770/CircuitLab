import type { Gate, Wire } from "@circuitlab/engine";
import { PIN_LENGTH, gateSize, pinCount, type Point } from "./geometry";

const COLUMN_WIDTH = 150;
const ROW_GAP = 34; // leaves room for the gate's name under it
const MARGIN = 40;

/**
 * Places every gate automatically, left to right in the direction the signals flow. The API
 * stores gates and wires but no positions, so a circuit made from a netlist has to be drawn
 * somehow. The rules:
 *
 * 1. Columns. INPUT and CONST gates go in column 0. Every other gate goes one column to the
 *    right of the furthest-right gate that feeds it. (The same idea as the engine's topological
 *    sort: a gate is placed once everything it depends on is placed.)
 * 2. Feedback loops, like a latch. Gates in a loop wait for each other forever, so when nothing is
 *    ready we place the first waiting gate anyway, using only the drivers already placed.
 * 3. OUTPUT gates all go in the last column, so results are always on the right.
 * 4. Rows. Within a column, each gate tries to sit level with the average of the gates that feed
 *    it, which keeps wires short and straight. Gates that would overlap are pushed down.
 */
export function autoLayout(gates: readonly Gate[], wires: readonly Wire[]): Map<string, Point> {
  const known = new Set(gates.map((gate) => gate.id));
  const drivers = new Map<string, string[]>();
  for (const gate of gates) drivers.set(gate.id, []);
  for (const wire of wires) {
    if (known.has(wire.from)) drivers.get(wire.to)?.push(wire.from);
  }
  const driversOf = (gate: Gate): string[] => drivers.get(gate.id) ?? [];

  // 1 and 2: columns.
  const column = new Map<string, number>();
  const placeAfterPlacedDrivers = (gate: Gate): void => {
    let furthest = -1;
    for (const driver of driversOf(gate)) furthest = Math.max(furthest, column.get(driver) ?? -1);
    column.set(gate.id, furthest + 1);
  };
  for (const gate of gates) {
    if (gate.type === "INPUT" || gate.type === "CONST") column.set(gate.id, 0);
  }
  let waiting = gates.filter((gate) => !column.has(gate.id));
  while (waiting.length > 0) {
    let ready = waiting.filter((gate) => driversOf(gate).every((driver) => column.has(driver)));
    if (ready.length === 0) {
      // A feedback loop: place one gate of it, preferably one with a driver already placed.
      const someFed = waiting.find((gate) => driversOf(gate).some((driver) => column.has(driver)));
      ready = [someFed ?? (waiting[0] as Gate)];
    }
    for (const gate of ready) placeAfterPlacedDrivers(gate);
    waiting = waiting.filter((gate) => !column.has(gate.id));
  }

  // 3: outputs in the last column.
  let lastColumn = 0;
  for (const gate of gates) {
    if (gate.type !== "OUTPUT") lastColumn = Math.max(lastColumn, (column.get(gate.id) ?? 0) + 1);
  }
  for (const gate of gates) {
    if (gate.type === "OUTPUT") column.set(gate.id, lastColumn);
  }

  // 4: rows, one column at a time from the left, so the drivers' rows are known.
  const byColumn: Gate[][] = [];
  for (const gate of gates) {
    const index = column.get(gate.id) ?? 0;
    (byColumn[index] ??= []).push(gate);
  }
  const positions = new Map<string, Point>();
  const centerY = new Map<string, number>(); // middle of each placed gate, where its output pin is
  byColumn.forEach((columnGates, index) => {
    const x = MARGIN + PIN_LENGTH + index * COLUMN_WIDTH;
    // Where each gate would like to be: level with the average of its drivers. Gates without
    // placed drivers (the inputs, for example) have no wish and go first, in their own order.
    const wishes = columnGates.map((gate) => ({ gate, y: averageDriverY(driversOf(gate), centerY) }));
    const noWish = wishes.filter((wish) => wish.y === null);
    const withWish = wishes.filter((wish) => wish.y !== null).sort((a, b) => (a.y ?? 0) - (b.y ?? 0)); // sort is stable: ties keep their order
    let nextFreeY = MARGIN;
    for (const { gate, y } of [...noWish, ...withWish]) {
      const { height } = gateSize(gate.type, pinCount(gate, wires));
      const top = y === null ? nextFreeY : Math.max(nextFreeY, y - height / 2);
      positions.set(gate.id, { x, y: Math.round(top) });
      centerY.set(gate.id, top + height / 2);
      nextFreeY = top + height + ROW_GAP;
    }
  });
  return positions;
}

function averageDriverY(drivers: readonly string[], centerY: ReadonlyMap<string, number>): number | null {
  let sum = 0;
  let count = 0;
  for (const driver of drivers) {
    const y = centerY.get(driver);
    if (y !== undefined) {
      sum += y;
      count += 1;
    }
  }
  return count === 0 ? null : sum / count;
}
