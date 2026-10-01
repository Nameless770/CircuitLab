import { assertValidCircuit, type Circuit } from "@circuitlab/engine";
import { IDENTIFIER } from "./parser";

const LINES_PER_CHUNK = 512;

/**
 * Writes a circuit as netlist text, lazily, in chunks of whole lines. That lets it feed a stream
 * without building the whole file in memory:
 *
 *   await pipeline(Readable.from(formatNetlist(circuit)), createWriteStream("adder.net"));
 *
 * Reading the output back gives the same gates and wires. The circuit is checked up front, not
 * when the first chunk is requested.
 *
 * @throws CircuitValidationError if the circuit is invalid
 * @throws RangeError if a gate id can't be written as a netlist name
 */
export function formatNetlist(circuit: unknown): IterableIterator<string> {
  assertValidCircuit(circuit);
  for (const gate of circuit.gates) {
    if (!IDENTIFIER.test(gate.id)) {
      throw new RangeError(`Gate id ${JSON.stringify(gate.id)} can't be written as a netlist name (allowed: letters, digits, _ . $ [ ])`);
    }
  }
  // Each gate's sources, by pin number.
  const sources = new Map<string, string[]>();
  for (const wire of circuit.wires) {
    let list = sources.get(wire.to);
    if (list === undefined) {
      list = [];
      sources.set(wire.to, list);
    }
    list[wire.toPin] = wire.from;
  }
  return chunks(circuit, sources);
}

function* chunks(circuit: Circuit, sources: ReadonlyMap<string, readonly string[]>): Generator<string, void, undefined> {
  let buffer: string[] = [];
  if (circuit.name !== undefined) buffer.push(`.name ${JSON.stringify(circuit.name)}\n`);

  for (const gate of circuit.gates) {
    const args =
      gate.type === "INPUT" ? "" : gate.type === "CONST" ? `(${gate.value})` : `(${(sources.get(gate.id) ?? []).join(", ")})`;
    const label = gate.label === undefined ? "" : ` ${JSON.stringify(gate.label)}`;
    buffer.push(`${gate.id} = ${gate.type}${args}${label}\n`);
    // Yield batches of lines: one chunk per line would make every stream stage do far more work.
    if (buffer.length >= LINES_PER_CHUNK) {
      yield buffer.join("");
      buffer = [];
    }
  }
  if (buffer.length > 0) yield buffer.join("");
}
