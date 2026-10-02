import { CycleError, OscillationError, SimulationInputError, combinational, truthTable, type Bit } from "@circuitlab/engine";
import { PoolBusyError, PoolClosedError, SimulationPool, WorkerCrashedError, pack, unpack } from "@circuitlab/runner";
import { afterEach, describe, expect, it } from "vitest";
import { circuit, fullAdder, inverterRing, random, randomCircuit, rippleCarryAdder, srLatch, type GateSpec } from "../../engine/test/fixtures";

/** A circuit whose full truth table (2^n rows) keeps a worker busy for a while. */
function busyWork(n = 22) {
  const specs: GateSpec[] = Array.from({ length: n }, (_, k): GateSpec => [`i${k}`, "INPUT"]);
  specs.push(["x", "XOR", ...specs.map(([id]) => id)], ["P", "OUTPUT", "x"]);
  return circuit("busy", ...specs);
}

/**
 * A million rows: about 1.5 s of work for one worker, and it fits in memory, so it ends the same
 * way however slow the machine. (The whole table would run the worker out of memory after a few
 * seconds: a different ending.) The tests cancel it within milliseconds.
 */
const BUSY = { limit: 2 ** 20 };

const pools: SimulationPool[] = [];
function pool(options: ConstructorParameters<typeof SimulationPool>[0]): SimulationPool {
  const created = new SimulationPool(options);
  pools.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((created) => created.destroy()));
});

describe("SimulationPool: same answers as the engine, computed on worker threads", () => {
  it("simulates random circuits exactly as the engine does locally", async () => {
    const workers = pool({ size: 2 });
    const next = random(5);
    for (let n = 0; n < 20; n++) {
      const source = randomCircuit(next, 3, 25);
      const inputs: Record<string, Bit> = { in0: next() < 0.5 ? 0 : 1, in1: next() < 0.5 ? 0 : 1, in2: next() < 0.5 ? 0 : 1 };
      expect(await workers.simulate(source, inputs)).toEqual(combinational.prepare(source).run(inputs));
    }
  });

  it("builds truth tables, and pages that add up to the whole table", async () => {
    const workers = pool({ size: 2 });
    const adder = rippleCarryAdder(4);
    const whole = truthTable(adder);
    expect(await workers.truthTable(adder)).toEqual(whole);
    const rows = [];
    for await (const page of workers.truthTablePages(adder, { pageSize: 100 })) {
      expect(page.rows.length).toBeLessThanOrEqual(100);
      rows.push(...page.rows);
    }
    expect(rows).toEqual(whole.rows);
  });

  it("hands out the same pages in their compact form, one byte per output and no inputs", async () => {
    const workers = pool({ size: 2 });
    const adder = rippleCarryAdder(4);
    const expected = truthTable(adder, { offset: 30, limit: 150 });
    const pages = [];
    for await (const page of workers.packedTruthTablePages(adder, { pageSize: 64, offset: 30, limit: 150 })) {
      expect(page.outputs).toHaveLength(page.rowCount * page.outputIds.length);
      pages.push(page);
    }
    expect(pages.map((page) => [page.offset, page.rowCount])).toEqual([[30, 64], [94, 64], [158, 22]]);
    expect(pages.flatMap((page) => unpack(page).rows)).toEqual(expected.rows);
    expect(unpack(pack(expected))).toEqual(expected);
  });

  it("rejects with the engine's own error classes, rebuilt on this side of the thread", async () => {
    const workers = pool({ size: 1 });
    await expect(workers.simulate(srLatch(), { S: 0, R: 0 })).rejects.toBeInstanceOf(CycleError);
    await expect(workers.simulate(fullAdder(), { A: 1 })).rejects.toBeInstanceOf(SimulationInputError);
    expect(await workers.simulate(fullAdder(), { A: 1, B: 1, Cin: 1 })).toMatchObject({ outputs: { S: 1, Cout: 1 } }); // still working
  });

  it("runs sequential simulations, state passed in and out across the thread", async () => {
    const workers = pool({ size: 1 });
    const set = await workers.simulate(srLatch(), { S: 1, R: 0 }, { mode: "sequential" });
    expect(set).toMatchObject({ mode: "sequential", outputs: { Q: 1 }, state: { q: 1, qbar: 0 } });
    const held = await workers.simulate(srLatch(), { S: 0, R: 0 }, { mode: "sequential", state: set.state });
    expect(held.outputs).toEqual({ Q: 1 });
    await expect(workers.simulate(inverterRing(3), {}, { mode: "sequential" })).rejects.toBeInstanceOf(OscillationError);
  });
});

describe("SimulationPool under pressure", () => {
  it("fails fast with PoolBusyError when every worker is busy and the queue is full", async () => {
    const workers = pool({ size: 1, maxQueue: 0 });
    const controller = new AbortController();
    const running = workers.truthTable(busyWork(), BUSY, { signal: controller.signal });
    await expect(workers.simulate(fullAdder(), { A: 0, B: 0, Cin: 0 })).rejects.toBeInstanceOf(PoolBusyError);
    controller.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("stops a running task when its signal fires, and the pool carries on", async () => {
    const workers = pool({ size: 1 });
    const started = Date.now();
    await expect(workers.truthTable(busyWork(), BUSY, { signal: AbortSignal.timeout(100) })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(Date.now() - started).toBeLessThan(2000); // the worker was stopped, not waited for
    expect(workers.stats.busy).toBe(0);
    expect(await workers.simulate(fullAdder(), { A: 1, B: 0, Cin: 0 })).toMatchObject({ outputs: { S: 1, Cout: 0 } });
  });

  it("drops a waiting task whose signal fires before it gets a worker", async () => {
    const workers = pool({ size: 1, maxQueue: 5 });
    const blocker = new AbortController();
    const running = workers.truthTable(busyWork(), BUSY, { signal: blocker.signal });
    const waiting = new AbortController();
    const queued = workers.simulate(fullAdder(), { A: 0, B: 0, Cin: 0 }, { signal: waiting.signal });
    expect(workers.stats.queued).toBe(1);
    waiting.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(workers.stats.queued).toBe(0);
    blocker.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("contains a task that runs out of memory to its own worker", async () => {
    const workers = pool({ size: 1, maxWorkerMemoryMb: 16 });
    const crash = await workers.truthTable(busyWork(), { limit: 2 ** 22 }).catch((error: unknown) => error);
    expect(crash).toBeInstanceOf(WorkerCrashedError);
    expect((crash as WorkerCrashedError).cause).toMatchObject({ code: "ERR_WORKER_OUT_OF_MEMORY" });
    expect(await workers.simulate(fullAdder(), { A: 1, B: 1, Cin: 0 })).toMatchObject({ outputs: { S: 0, Cout: 1 } });
  }, 30_000);

  it("refuses new tasks once closed, and lets the running one finish", async () => {
    const workers = pool({ size: 1 });
    const running = workers.simulate(fullAdder(), { A: 1, B: 1, Cin: 1 });
    const closing = workers.close();
    await expect(workers.simulate(fullAdder(), { A: 0, B: 0, Cin: 0 })).rejects.toBeInstanceOf(PoolClosedError);
    expect(await running).toMatchObject({ outputs: { S: 1, Cout: 1 } });
    await closing;
  });
});
