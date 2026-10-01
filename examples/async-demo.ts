/**
 * Phase 2 demo, part 2: running simulations off the main thread with SimulationPool.
 *
 *   npm run demo:async        (from the repository root)
 */
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CycleError, truthTable, type Circuit, type SimulationInputs, type TruthTableRow } from "@circuitlab/engine";
import { importNetlistFile } from "@circuitlab/netlist";
import { PoolError, SimulationPool } from "@circuitlab/runner";
import { fromBits, print, rippleCarryAdder, section } from "./circuits";

const netlist = (name: string): string => join(__dirname, "..", "netlists", name);
const fmt = (n: number): string => Math.round(n).toLocaleString("en");

interface Timing {
  readonly ms: number;
  /** Longest stretch during which the main thread could not run anything else. */
  readonly longestBlock: number;
}

/**
 * Runs `work` while a 5 ms heartbeat timer ticks, and reports the longest gap between beats.
 * In a server, that gap is how long every other request would have to wait.
 */
async function withHeartbeat(work: () => unknown): Promise<Timing> {
  let last = performance.now();
  let longestBlock = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    longestBlock = Math.max(longestBlock, now - last);
    last = now;
  }, 5);
  await sleep(30); // let the heartbeat settle into its rhythm
  longestBlock = 0;

  const start = performance.now();
  await work();
  const ms = performance.now() - start;
  await sleep(30); // let one more beat land, so a block at the very end is measured too
  clearInterval(heartbeat);
  return { ms, longestBlock };
}

function report(label: string, { ms, longestBlock }: Timing): void {
  print(`${label.padEnd(36)} ${fmt(ms).padStart(5)} ms total, main thread blocked for up to ${fmt(longestBlock).padStart(3)} ms`);
}

/** For the adder's truth table: the row number is A, B, cin in binary; the outputs are the sum. */
function addsUp(bits: number): (row: TruthTableRow) => boolean {
  return (row) => {
    const cin = row.index % 2;
    const b = Math.floor(row.index / 2) % 2 ** bits;
    const a = Math.floor(row.index / 2 ** (bits + 1));
    return fromBits(row.outputs) === BigInt(a + b + cin);
  };
}

/**
 * Starts every worker and runs each code path once, so that thread start-up and first-time
 * JIT compilation don't distort the timings. A long-running server is always in this state.
 */
async function warmUp(pool: SimulationPool): Promise<void> {
  const tiny = { gates: [{ id: "a", type: "INPUT" }], wires: [] };
  await Promise.all(Array.from({ length: pool.size }, () => pool.simulate(tiny, { a: 0 })));
  const small = rippleCarryAdder(5);
  const check = addsUp(5);
  truthTable(small).rows.forEach(check);
  (await pool.truthTable(small)).rows.forEach(check);
  for await (const page of pool.truthTablePages(small, { pageSize: 256 })) page.rows.forEach(check);
}

async function keepTheLoopFree(pool: SimulationPool): Promise<void> {
  section("1. Keeping the main thread free");
  const bits = 8;
  const adder = rippleCarryAdder(bits);
  print(`Task: the truth table of an ${bits}-bit adder, ${fmt(2 ** (2 * bits + 1))} rows. A 5 ms heartbeat timer`);
  print("shows how long the main thread goes without being able to do anything else.\n");

  report("On the main thread", await withHeartbeat(() => truthTable(adder)));
  report("On one worker, whole table at once", await withHeartbeat(() => pool.truthTable(adder)));

  let checked = 0;
  let correct = 0;
  const check = addsUp(bits);
  const paged = await withHeartbeat(async () => {
    for await (const page of pool.truthTablePages(adder)) {
      for (const row of page.rows) {
        checked++;
        if (check(row)) correct++;
      }
    }
  });
  report(`On ${pool.size} workers, pages of 1,024 rows`, paged);

  print("\nA worker alone is not enough: the finished table must come back, and turning it into");
  print("row objects happens on the main thread. The pool keeps that cheap (rows travel packed into");
  print("bytes, and the buffer is handed over instead of copied), and paging splits what is left");
  print("into small steps, with the event loop running in between. Meanwhile, several workers");
  print("compute pages in parallel.");
  print(`\n${correct === checked ? "OK" : "FAILED"}: ${fmt(correct)} of ${fmt(checked)} paged rows satisfy A + B + cin = sum`);
}

async function cancellation(pool: SimulationPool): Promise<void> {
  section("2. Timeouts and cancellation");
  const big = rippleCarryAdder(10); // 2,097,152 rows: seconds of work

  let start = performance.now();
  try {
    await pool.truthTable(big, {}, { signal: AbortSignal.timeout(100) });
  } catch (error) {
    print(`AbortSignal.timeout(100):  ${(error as Error).name} after ${fmt(performance.now() - start)} ms`);
  }

  const controller = new AbortController();
  start = performance.now();
  setTimeout(() => controller.abort(new Error("the user pressed Cancel")), 50);
  try {
    await pool.truthTable(big, {}, { signal: controller.signal });
  } catch (error) {
    print(`controller.abort(reason): rejected after ${fmt(performance.now() - start)} ms with "${(error as Error).message}"`);
  }

  let pages = 0;
  for await (const page of pool.truthTablePages(big)) {
    if (++pages === 3) break; // the pages still being computed are cancelled
    void page;
  }
  print(`break out of truthTablePages after ${pages} of 2,048 pages: the rest are never computed`);

  print("\nA running simulation is plain synchronous JavaScript, which can't be interrupted, so");
  print("cancelling stops its worker thread and the pool starts a fresh one. The pool still works:");
  const halfAdder = await importNetlistFile(netlist("half-adder.net"));
  const { outputs } = await pool.simulate(halfAdder, { A: 1, B: 1 });
  print(`half adder, A=1 B=1 -> ${JSON.stringify(outputs)}`);
}

async function errorsCrossThreads(pool: SimulationPool): Promise<void> {
  section("3. Engine errors cross the thread boundary intact");
  const latch = await importNetlistFile(netlist("sr-latch.net"));
  try {
    await pool.simulate(latch, { S: 0, R: 0 });
  } catch (error) {
    print(`${(error as Error).name}: ${(error as Error).message}`);
    if (error instanceof CycleError) print(`instanceof CycleError: true, error.cycle = ${JSON.stringify(error.cycle)}`);
  }

  const halfAdder = await importNetlistFile(netlist("half-adder.net"));
  const badInputs: SimulationInputs = JSON.parse('{ "A": 1, "B": "1", "Cin": 0 }');
  try {
    await pool.simulate(halfAdder, badInputs);
  } catch (error) {
    print(`\n${(error as Error).name}: ${(error as Error).message}`);
  }
}

async function runawayTask(): Promise<void> {
  section("4. A runaway task only takes down its own worker");
  const fragile = new SimulationPool({ size: 1, maxWorkerMemoryMb: 64 });
  try {
    try {
      await fragile.truthTable(rippleCarryAdder(10)); // two million rows won't fit in 64 MB
    } catch (error) {
      if (!(error instanceof PoolError)) throw error;
      print(`${error.name}: ${error.message}`);
      print(`cause: ${(error.cause as NodeJS.ErrnoException | undefined)?.code}`);
    }
    const halfAdder: Circuit = await importNetlistFile(netlist("half-adder.net"));
    const { outputs } = await fragile.simulate(halfAdder, { A: 1, B: 0 });
    print(`The main process is unharmed and the next task ran on a fresh worker: ${JSON.stringify(outputs)}`);
  } finally {
    await fragile.close();
  }
}

async function fullQueue(): Promise<void> {
  section("5. Backpressure: failing fast when the queue is full");
  const tiny = new SimulationPool({ size: 1, maxQueue: 2 });
  const adder = rippleCarryAdder(8);
  const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => tiny.truthTable(adder, { limit: 20_000 })));
  outcomes.forEach((outcome, k) =>
    print(
      `task ${k + 1}: ${outcome.status === "fulfilled" ? `done, ${fmt(outcome.value.rows.length)} rows` : `${(outcome.reason as Error).name}`}`,
    ),
  );
  print("\nOne worker, two waiting places: tasks 4 and 5 are refused at once instead of piling up.");
  print("An API can turn PoolBusyError into HTTP 503 with a Retry-After header.");

  const closing = tiny.close();
  const late = await tiny.simulate(rippleCarryAdder(1), { a0: 1, b0: 1, cin: 0 }).catch((error: Error) => error.name);
  await closing;
  print(`A task submitted after close(): ${String(late)}`);
}

async function main(): Promise<void> {
  const pool = new SimulationPool();
  try {
    await warmUp(pool);
    await keepTheLoopFree(pool);
    await cancellation(pool);
    await errorsCrossThreads(pool);
  } finally {
    await pool.close();
  }
  await runawayTask();
  await fullQueue();
  console.log();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
