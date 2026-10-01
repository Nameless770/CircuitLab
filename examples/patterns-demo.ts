/**
 * Phase 9 demo: the design patterns at work.
 *
 *   npm run demo:patterns        (from the repository root)
 *
 * 1. The gate registry and the gate factory: every gate type defined once.
 * 2. Simulation strategies: combinational and sequential, chosen by name, used the same way. The
 *    sequential one runs what combinational simulation can't: latches, flip-flops, counters.
 * 3. Dependency injection: the API gets the time from an injected Clock, so 30 days can pass in a
 *    millisecond.
 */
import type { AddressInfo } from "node:net";
import { AppConfig, Clock, createApp } from "@circuitlab/api";
import {
  CycleError,
  GATE_DEFINITIONS,
  GATE_TYPES,
  OscillationError,
  SIMULATION_MODES,
  createGateNode,
  simulationStrategy,
  type Bit,
  type Circuit,
  type Gate,
  type SimulationState,
} from "@circuitlab/engine";
import { print, rippleCarryAdder, section } from "./circuits";

// ---------------------------------------------------------------------------------------------
// Circuits with memory, built from NAND and NOR gates
// ---------------------------------------------------------------------------------------------

/** Builds a circuit from "id = TYPE(sources)" specs. */
function build(name: string, specs: [id: string, type: Gate["type"], ...sources: string[]][]): Circuit {
  return {
    name,
    gates: specs.map(([id, type]) => ({ id, type }) as Gate),
    wires: specs.flatMap(([id, , ...sources]) => sources.map((from, toPin) => ({ from, to: id, toPin }))),
  };
}

const srLatch = build("SR latch", [["S", "INPUT"], ["R", "INPUT"], ["q", "NOR", "R", "qbar"], ["qbar", "NOR", "S", "q"], ["Q", "OUTPUT", "q"]]);

/** A gated D latch from NAND gates (q follows d while e is 1). */
const dLatch = (p: string, d: string, e: string): [string, Gate["type"], ...string[]][] => [
  [`${p}nd`, "NOT", d],
  [`${p}s`, "NAND", d, e],
  [`${p}r`, "NAND", `${p}nd`, e],
  [`${p}q`, "NAND", `${p}s`, `${p}qb`],
  [`${p}qb`, "NAND", `${p}r`, `${p}q`],
];

/** Two master-slave flip-flops: bit 0 toggles on every rising clock edge, bit 1 on every falling edge of bit 0. */
const counter = build("2-bit counter", [
  ["CLK", "INPUT"],
  ["nclk", "NOT", "CLK"],
  ["d0", "NOT", "a.sq"],
  ...dLatch("a.m", "d0", "nclk"),
  ...dLatch("a.s", "a.mq", "CLK"),
  ["nq0", "NOT", "a.sq"], // bit 1 is clocked by bit 0 falling: a ripple counter
  ["d1", "NOT", "b.sq"],
  ["nnq0", "NOT", "nq0"],
  ...dLatch("b.m", "d1", "nnq0"),
  ...dLatch("b.s", "b.mq", "nq0"),
  ["Q0", "OUTPUT", "a.sq"],
  ["Q1", "OUTPUT", "b.sq"],
]);

const ring = build("3-inverter ring", [["a", "NOT", "c"], ["b", "NOT", "a"], ["c", "NOT", "b"], ["Y", "OUTPUT", "a"]]);

/** A row of bits drawn as a waveform: ‾ for 1, _ for 0. */
const wave = (bits: readonly (Bit | undefined)[]): string => bits.map((bit) => (bit === 1 ? "‾‾" : "__")).join("");

// ---------------------------------------------------------------------------------------------

function registry(): void {
  section("1. The gate registry and the gate factory");
  print("Every gate type is defined once, in GATE_DEFINITIONS; validation, the netlist reader, and the");
  print("factory all read it. A new type is one entry here, plus its name in the API spec and the database");
  print("enum (the spec tests and db:check fail until both list exactly the registry's types).\n");
  for (const type of GATE_TYPES) {
    const { arity, behaviour, description } = GATE_DEFINITIONS[type];
    const pins = arity.min === arity.max ? String(arity.min) : `${arity.min}-${arity.max}`;
    print(`${type.padEnd(7)} ${pins.padStart(5)} inputs   ${behaviour.kind.padEnd(6)} ${description}`);
  }
  print("\nThe factory turns gates as data into nodes a simulation can run:");
  const nodes = [
    createGateNode({ id: "A", type: "INPUT" }, 0, [], 0),
    createGateNode({ id: "one", type: "CONST", value: 1 }, 1, [], -1),
    createGateNode({ id: "x", type: "XOR" }, 2, [0, 1], -1),
  ];
  for (const node of nodes) {
    const detail = node.kind === "logic" ? `computes from slots ${node.sources.join(", ")}` : node.kind === "input" ? `reads input #${node.input}` : `is always ${node.value}`;
    print(`  slot ${node.slot}: ${node.kind.padEnd(5)} ${detail}`);
  }
}

function strategies(): void {
  section("2. Simulation strategies: chosen by name, used the same way");
  const adder = rippleCarryAdder(4);
  const inputs = Object.fromEntries(adder.gates.filter((gate) => gate.type === "INPUT").map((gate, k): [string, Bit] => [gate.id, (k % 3 === 0 ? 1 : 0) as Bit]));
  for (const mode of SIMULATION_MODES) {
    const result = simulationStrategy(mode).prepare(adder).run(inputs);
    const sum = adder.gates.filter((gate) => gate.type === "OUTPUT").map((gate) => result.outputs[gate.id]).join("");
    print(`${mode.padEnd(14)} 4-bit adder: outputs ${sum}${result.mode === "sequential" ? `, ${result.evaluations} evaluations, state ${JSON.stringify(result.state)}` : ""}`);
  }
  print("Without feedback loops both strategies agree (a test checks 200 random circuits).\n");

  try {
    simulationStrategy("combinational").prepare(srLatch);
  } catch (error) {
    if (error instanceof CycleError) print(`combinational  SR latch: refused, feedback loop ${error.cycle.join(" -> ")}`);
  }
  const latch = simulationStrategy("sequential").prepare(srLatch);
  print(`sequential     SR latch: state held by ${latch.stateIds.join(" and ")}`);
  let state: SimulationState | undefined;
  for (const [label, inputsNow] of [["set", { S: 1, R: 0 }], ["hold", { S: 0, R: 0 }], ["reset", { S: 0, R: 1 }], ["hold", { S: 0, R: 0 }]] as const) {
    const result = latch.run(inputsNow, state);
    if (result.mode !== "sequential") continue;
    print(`               ${label.padEnd(5)} S=${inputsNow.S} R=${inputsNow.R} -> Q=${result.outputs.Q}   state ${JSON.stringify(result.state)}`);
    state = result.state;
  }

  print("\nA 2-bit ripple counter (two flip-flops, each two NAND latches), clocked 16 times:");
  const prepared = simulationStrategy("sequential").prepare(counter);
  const clock: Bit[] = [];
  const q0: (Bit | undefined)[] = [];
  const q1: (Bit | undefined)[] = [];
  state = undefined;
  for (let tick = 0; tick < 16; tick++) {
    const level = (tick % 2) as Bit;
    const result = prepared.run({ CLK: level }, state);
    if (result.mode !== "sequential") continue;
    clock.push(level);
    q0.push(result.outputs.Q0);
    q1.push(result.outputs.Q1);
    state = result.state;
  }
  print(`  CLK ${wave(clock)}`);
  print(`  Q0  ${wave(q0)}   half the clock's frequency`);
  print(`  Q1  ${wave(q1)}   a quarter: together, Q1 Q0 count 0 1 2 3 (from wherever power-up left them)`);

  print("");
  try {
    simulationStrategy("sequential").prepare(ring).run({});
  } catch (error) {
    if (error instanceof OscillationError) print(`sequential     3-inverter ring: ${error.message}`);
  }
}

/** A clock the demo sets by hand: the API takes it through dependency injection. */
class DemoClock extends Clock {
  private time = Date.now();
  now(): Date {
    return new Date(this.time);
  }
  advanceDays(days: number): void {
    this.time += days * 24 * 60 * 60 * 1000;
  }
}

async function injection(): Promise<void> {
  section("3. Dependency injection: the API's clock is injected");
  const clock = new DemoClock();
  const app = await createApp({ config: new AppConfig({ port: 0, simulationWorkers: 1, jwtSecret: "a demo secret, at least thirty-two characters" }), clock, logLevels: ["error"] });
  await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, token?: string): Promise<{ status: number; body: any }> => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token !== undefined && { Authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json().catch(() => undefined) };
  };
  try {
    const account = await post("/v1/auth/register", { email: "demo@example.com", password: "a passphrase for the demo", displayName: "Demo" });
    print(`Registered; the refresh token is valid for 30 days without use.`);
    clock.advanceDays(29);
    const refreshed = await post("/v1/auth/refresh", { refreshToken: account.body.refreshToken });
    print(`29 days later: POST /v1/auth/refresh -> ${refreshed.status} (and the 30 days start over)`);
    clock.advanceDays(31);
    const late = await post("/v1/auth/refresh", { refreshToken: refreshed.body.refreshToken });
    print(`31 more days:  POST /v1/auth/refresh -> ${late.status} ${late.body.code}: the session ended`);
    print("Two months passed in the API without waiting: it never reads Date itself, only its Clock.\n");

    const fresh = await post("/v1/auth/login", { email: "demo@example.com", password: "a passphrase for the demo" });
    const circuit = await post("/v1/circuits", srLatch, fresh.body.accessToken);
    const path = `/v1/circuits/${circuit.body.id}/simulate`;
    const set = await post(path, { inputs: { S: 1, R: 0 }, mode: "sequential" }, fresh.body.accessToken);
    const held = await post(path, { inputs: { S: 0, R: 0 }, mode: "sequential", state: set.body.state }, fresh.body.accessToken);
    print("The same strategies over HTTP: the client carries the state from one step to the next.");
    print(`POST ${path.slice(0, 22)}.../simulate  {"inputs": {"S": 1, "R": 0}, "mode": "sequential"}  -> Q=${set.body.outputs.Q}, state ${JSON.stringify(set.body.state)}`);
    print(`POST ${path.slice(0, 22)}.../simulate  {"inputs": {"S": 0, "R": 0}, "mode": "sequential", "state": ...}  -> Q=${held.body.outputs.Q}`);
  } finally {
    await app.close();
  }
}

async function main(): Promise<void> {
  registry();
  strategies();
  await injection();
  console.log();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
