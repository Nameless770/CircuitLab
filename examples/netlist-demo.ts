/**
 * Phase 2 demo, part 1: reading circuits from netlist files with streams.
 *
 *   npm run demo:netlist        (from the repository root)
 */
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { CircuitLabError, compileCircuit, simulate, truthTable, type Bit } from "@circuitlab/engine";
import { formatNetlist, importNetlist, importNetlistFile } from "@circuitlab/netlist";
import { fromBits, print, rippleCarryAdder, section, toBits } from "./circuits";

const netlist = (name: string): string => join(__dirname, "..", "netlists", name);
const elapsed = (since: number): string => `${Math.round(performance.now() - since)} ms`;

async function importSmallFiles(): Promise<void> {
  section("Importing netlist files");
  for (const name of ["half-adder.net", "full-adder.net", "c17.net", "sr-latch.net"]) {
    const circuit = await importNetlistFile(netlist(name));
    const ids = (type: string): string => circuit.gates.filter((gate) => gate.type === type).map((gate) => gate.id).join(" ");
    print(`${name.padEnd(15)} ${JSON.stringify(circuit.name)}: ${circuit.gates.length} gates, ${circuit.wires.length} wires`);
    print(`${"".padEnd(15)} inputs ${ids("INPUT")}; outputs ${ids("OUTPUT")}`);
  }

  print("\nsr-latch.net imports fine, because a feedback loop is valid structure. Only compiling");
  print("it for combinational simulation fails:");
  try {
    compileCircuit(await importNetlistFile(netlist("sr-latch.net")));
  } catch (error) {
    if (!(error instanceof CircuitLabError)) throw error;
    print(`  ${error.name}: ${error.message}`);
  }
}

async function checkC17(): Promise<void> {
  section("Checking ISCAS-85 c17 against its published equations");
  const table = truthTable(await importNetlistFile(netlist("c17.net")));
  const nand = (x: Bit, y: Bit): Bit => (x === 1 && y === 1 ? 0 : 1);

  let mismatches = 0;
  for (const row of table.rows) {
    const [n1, n2, n3, n6, n7] = row.inputs as [Bit, Bit, Bit, Bit, Bit];
    const n22 = nand(nand(n1, n3), nand(n2, nand(n3, n6)));
    const n23 = nand(nand(n2, nand(n3, n6)), nand(nand(n3, n6), n7));
    if (row.outputs[0] !== n22 || row.outputs[1] !== n23) mismatches++;
  }
  print("N22 = NAND(NAND(N1,N3), NAND(N2, NAND(N3,N6)))");
  print("N23 = NAND(NAND(N2, NAND(N3,N6)), NAND(NAND(N3,N6), N7))");
  print(`${mismatches === 0 ? "OK" : "FAILED"}: ${table.rows.length - mismatches} of ${table.rows.length} rows match`);
}

async function showErrors(): Promise<void> {
  section("A broken netlist: every problem, with file:line:column");
  try {
    await importNetlistFile(netlist("broken.net"));
  } catch (error) {
    if (!(error instanceof CircuitLabError)) throw error;
    print(`${error.name}: ${error.message}`);
  }

  print("\nA missing file is not a netlist problem, so Node's own error comes through unchanged:");
  try {
    await importNetlistFile(netlist("no-such-file.net"));
  } catch (error) {
    const { code, syscall } = error as NodeJS.ErrnoException;
    print(`  ${(error as Error).name} ${code} (${syscall})`);
  }
}

async function oneByteAtATime(): Promise<void> {
  section("Chunks can end anywhere");
  const text = '.name "Café"\nA = INPUT\nY = OUTPUT(A) "naïve"\n';
  const bytes = Buffer.from(text, "utf8");
  const chunks = Array.from(bytes, (byte) => Buffer.of(byte));

  const circuit = await importNetlist(Readable.from(chunks));
  const label = circuit.gates.find((gate) => gate.id === "Y")?.label;
  print(`Fed ${bytes.length} bytes one at a time, splitting every line and the two-byte "é" and "ï":`);
  print(`name ${JSON.stringify(circuit.name)}, label ${JSON.stringify(label)}, ${circuit.gates.length} gates`);
}

async function bigFileRoundTrip(): Promise<void> {
  section("A big netlist, streamed to disk and back");
  const bits = 10_000;
  const adder = rippleCarryAdder(bits);
  const directory = await mkdtemp(join(tmpdir(), "circuitlab-"));
  try {
    const path = join(directory, `adder-${bits}.net.gz`);
    let start = performance.now();
    // formatNetlist is lazy: the next lines are only generated when gzip asks for more (backpressure).
    await pipeline(Readable.from(formatNetlist(adder)), createGzip(), createWriteStream(path));
    const { size } = await stat(path);
    print(`Wrote ${adder.gates.length.toLocaleString("en")} gates to ${basename(path)} (${Math.round(size / 1024)} KB) in ${elapsed(start)}.`);

    start = performance.now();
    const imported = await importNetlistFile(path);
    print(
      `Read it back in ${elapsed(start)}: ${imported.gates.length.toLocaleString("en")} gates, ` +
        `${imported.wires.length.toLocaleString("en")} wires, never holding the whole text in memory.`,
    );

    // Prove the round trip worked: add two random 10,000-bit numbers with the imported circuit.
    const a = randomNumber(bits);
    const b = randomNumber(bits);
    const inputs: Record<string, Bit> = { cin: 0 };
    toBits(a, bits).forEach((bit, k) => (inputs[`a${bits - 1 - k}`] = bit));
    toBits(b, bits).forEach((bit, k) => (inputs[`b${bits - 1 - k}`] = bit));
    const { outputs } = simulate(compileCircuit(imported), inputs);
    const sumIds = ["cout", ...Array.from({ length: bits }, (_, k) => `s${bits - 1 - k}`)];
    const sum = fromBits(sumIds.map((id) => outputs[id] ?? 0));
    print(`Adding two random ${bits.toLocaleString("en")}-bit numbers with it: ${sum === a + b ? "OK, matches" : "FAILED, differs from"} a + b computed with BigInt.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function randomNumber(bits: number): bigint {
  return BigInt(`0x${randomBytes(Math.ceil(bits / 8)).toString("hex")}`) & ((1n << BigInt(bits)) - 1n);
}

async function main(): Promise<void> {
  await importSmallFiles();
  await checkC17();
  await showErrors();
  await oneByteAtATime();
  await bigFileRoundTrip();
  console.log();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
