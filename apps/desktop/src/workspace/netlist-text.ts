import type { Gate, Wire } from "@circuitlab/engine";

/**
 * A drawing written as netlist text, for the netlist editor: the same lines as the netlist
 * package's formatNetlist (packages/netlist/src/format.ts), one gate per line. Unlike that one, it
 * also writes a drawing that isn't finished: an input pin with no wire is left empty, as in
 * `AND(A, )`, so the editor shows exactly what is missing. Saving still goes through the real
 * writer in the main process, which checks the circuit first.
 */
export function writeNetlist(circuit: { readonly name: string; readonly gates: readonly Gate[]; readonly wires: readonly Wire[] }, pins?: ReadonlyMap<string, number>): string {
  const sources = new Map<string, (string | undefined)[]>();
  for (const wire of circuit.wires) {
    let list = sources.get(wire.to);
    if (list === undefined) {
      list = [];
      sources.set(wire.to, list);
    }
    list[wire.toPin] = wire.from;
  }
  const lines = [`.name ${JSON.stringify(circuit.name)}`];
  for (const gate of circuit.gates) {
    let args = "";
    if (gate.type === "CONST") args = `(${gate.value})`;
    else if (gate.type !== "INPUT") {
      const wired = sources.get(gate.id) ?? [];
      const count = Math.max(wired.length, pins?.get(gate.id) ?? 0);
      args = `(${Array.from({ length: count }, (_, pin) => wired[pin] ?? "").join(", ")})`;
    }
    const label = gate.label === undefined ? "" : ` ${JSON.stringify(gate.label)}`;
    lines.push(`${gate.id} = ${gate.type}${args}${label}`);
  }
  return `${lines.join("\n")}\n`;
}

/** What a new netlist starts with. */
export const NETLIST_TEMPLATE = `# One gate per line:  name = TYPE(inputs, in pin order)  "optional label"
.name "My circuit"

A = INPUT
B = INPUT

both = AND(A, B)

Y = OUTPUT(both)
`;
