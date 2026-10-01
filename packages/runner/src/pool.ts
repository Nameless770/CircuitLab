import { availableParallelism } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import {
  CompiledCircuit,
  reviveError,
  type SimulationInputs,
  type SimulationResult,
  type TruthTable,
  type TruthTableRange,
} from "@circuitlab/engine";
import { PoolBusyError, PoolClosedError, WorkerCrashedError } from "./errors";
import { unpack, type PackedTruthTable, type TaskFailure, type TaskPayload, type TaskRequest, type TaskResponse } from "./protocol";

const WORKER_FILE = join(__dirname, "worker.js");

export interface SimulationPoolOptions {
  /** Most worker threads to run. Default: one less than the number of CPUs, at least 1. */
  readonly size?: number;
  /** Tasks allowed to wait for a free worker. Past this, new tasks fail fast with PoolBusyError. Default 100. */
  readonly maxQueue?: number;
  /** Heap limit per worker in MB. A task that needs more crashes only its own worker. Default 512. */
  readonly maxWorkerMemoryMb?: number;
}

export interface TaskOptions {
  /**
   * Cancels the task. A waiting task is dropped; a running one has its worker stopped.
   * The promise rejects with `signal.reason`, so `AbortSignal.timeout(ms)` gives a TimeoutError.
   */
  readonly signal?: AbortSignal;
}

export interface PageOptions extends TaskOptions {
  /** Rows per page. Default 1024: small enough that handling one page never holds up the main thread for long. */
  readonly pageSize?: number;
  /** First row. Default 0. */
  readonly offset?: number;
  /** Most rows in total. Default: every row from `offset` to the end of the table. */
  readonly limit?: number;
}

export interface PoolStats {
  readonly workers: number;
  readonly busy: number;
  readonly queued: number;
}

interface Task {
  readonly request: TaskRequest;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

/** One worker thread and the task it is running, if any. */
interface Slot {
  readonly worker: Worker;
  task: Task | undefined;
}

/**
 * Runs simulations on a fixed number of worker threads, so heavy work never blocks the main
 * event loop (in a server, that loop is what answers every other request).
 *
 * Engine errors (CircuitValidationError, CycleError, ...) reject the promise exactly as they
 * would locally. Problems with the pool itself are PoolError subclasses.
 */
export class SimulationPool {
  readonly size: number;
  private readonly maxQueue: number;
  private readonly maxWorkerMemoryMb: number;
  private readonly slots = new Set<Slot>();
  private readonly queue: Task[] = [];
  private readonly unsettled = new Set<Promise<unknown>>();
  private nextTaskId = 1;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(options: SimulationPoolOptions = {}) {
    this.size = positiveInteger("size", options.size ?? Math.max(1, availableParallelism() - 1));
    this.maxQueue = positiveInteger("maxQueue", options.maxQueue ?? 100, 0);
    this.maxWorkerMemoryMb = positiveInteger("maxWorkerMemoryMb", options.maxWorkerMemoryMb ?? 512);
  }

  /** Simulates one set of inputs. `circuit` is plain data (e.g. parsed JSON) and is validated in the worker. */
  simulate(circuit: unknown, inputs: SimulationInputs, options?: TaskOptions): Promise<SimulationResult> {
    return this.run({ kind: "simulate", circuit, inputs }, options) as Promise<SimulationResult>;
  }

  /**
   * Builds a truth table, or one window of it (see TruthTableRange), on a worker.
   *
   * The rows travel back in compact form and are expanded into objects on the main thread,
   * which costs roughly 0.7 µs per row there. For big tables, use `truthTablePages`.
   */
  async truthTable(circuit: unknown, range: TruthTableRange = {}, options?: TaskOptions): Promise<TruthTable> {
    return unpack(await this.packedTruthTable(circuit, range, options));
  }

  /**
   * Streams a truth table (all of it, or `offset`/`limit` rows) as pages, in order, computing up
   * to one page per worker in parallel. It only runs ahead of the consumer by that many pages
   * (backpressure); if the consumer stops early (`break`), the pages still being computed are
   * cancelled; and it lets the event loop run between pages, so other work never waits long.
   *
   *   for await (const page of pool.truthTablePages(circuit)) sendToClient(page.rows);
   */
  async *truthTablePages(circuit: unknown, options: PageOptions = {}): AsyncGenerator<TruthTable, void, undefined> {
    const pageSize = positiveInteger("pageSize", options.pageSize ?? 1024);
    const start = positiveInteger("offset", options.offset ?? 0, 0);
    const wanted = positiveInteger("limit", options.limit ?? Number.MAX_SAFE_INTEGER, 0);
    const stop = new AbortController();
    const signal = options.signal === undefined ? stop.signal : AbortSignal.any([options.signal, stop.signal]);
    const page = (offset: number, limit: number): Promise<PackedTruthTable> =>
      this.packedTruthTable(circuit, { offset, limit }, { signal });

    // The first page also validates the circuit and tells us the table's size.
    const first = await page(start, Math.min(pageSize, wanted));
    const end = Math.min(first.totalRows, start + wanted);
    const ahead: Promise<PackedTruthTable>[] = [];
    let next = start + pageSize;
    const requestMore = (): void => {
      while (ahead.length < this.size && next < end) {
        ahead.push(page(next, Math.min(pageSize, end - next)));
        next += pageSize;
      }
    };
    try {
      requestMore();
      yield unpack(first);
      for (let current = ahead.shift(); current !== undefined; current = ahead.shift()) {
        const result = await current;
        requestMore();
        // Several pages often finish together. Without this, the consumer would process them all
        // in one go (resolved promises chain as microtasks), and timers and I/O would wait.
        await setImmediate();
        yield unpack(result);
      }
    } finally {
      // Runs on normal completion, on error, and when the consumer breaks out of its loop.
      stop.abort();
      for (const pending of ahead) pending.catch(() => {}); // cancelled on purpose; not an unhandled rejection
    }
  }

  private packedTruthTable(circuit: unknown, range: TruthTableRange, options?: TaskOptions): Promise<PackedTruthTable> {
    return this.run({ kind: "truthTable", circuit, range }, options) as Promise<PackedTruthTable>;
  }

  get stats(): PoolStats {
    let busy = 0;
    for (const slot of this.slots) if (slot.task !== undefined) busy++;
    return { workers: this.slots.size, busy, queued: this.queue.length };
  }

  /**
   * Stops accepting tasks, rejects the waiting ones with PoolClosedError, lets running ones
   * finish, then stops every thread. Safe to call more than once.
   */
  close(): Promise<void> {
    this.closing ??= this.shutDown();
    return this.closing;
  }

  /** Like close(), but also stops running tasks immediately (they reject with PoolClosedError). */
  async destroy(): Promise<void> {
    this.closed = true;
    this.rejectQueued();
    await Promise.all(
      [...this.slots].map((slot) => {
        const task = slot.task;
        if (task !== undefined) this.settle(task, () => task.reject(new PoolClosedError()));
        return this.retire(slot);
      }),
    );
  }

  private async shutDown(): Promise<void> {
    this.closed = true;
    this.rejectQueued();
    await Promise.allSettled(this.unsettled);
    await Promise.all([...this.slots].map((slot) => this.retire(slot)));
  }

  private run(payload: TaskPayload, { signal }: TaskOptions = {}): Promise<unknown> {
    if (this.closed) return Promise.reject(new PoolClosedError());
    if (payload.circuit instanceof CompiledCircuit) {
      return Promise.reject(
        new TypeError("Pass the plain circuit object: a CompiledCircuit holds functions, which cannot be sent to a thread"),
      );
    }
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.hasFreeWorker() && this.queue.length >= this.maxQueue) {
      return Promise.reject(new PoolBusyError(this.queue.length));
    }

    const promise = new Promise<unknown>((resolve, reject) => {
      const task: Task = {
        request: { ...payload, id: this.nextTaskId++ },
        resolve,
        reject,
        signal,
        onAbort: () => this.cancel(task),
      };
      signal?.addEventListener("abort", task.onAbort, { once: true });
      this.queue.push(task);
      this.dispatch();
    });
    const forget = (): void => void this.unsettled.delete(promise);
    this.unsettled.add(promise);
    promise.then(forget, forget);
    return promise;
  }

  /** Hands waiting tasks to free workers, starting new workers up to `size`. */
  private dispatch(): void {
    while (this.queue.length > 0) {
      const slot = this.freeSlot();
      if (slot === undefined) return;
      const task = this.queue.shift();
      if (task === undefined) return;
      this.start(slot, task);
    }
  }

  private hasFreeWorker(): boolean {
    return this.slots.size < this.size || [...this.slots].some((slot) => slot.task === undefined);
  }

  private freeSlot(): Slot | undefined {
    for (const slot of this.slots) if (slot.task === undefined) return slot;
    return this.slots.size < this.size ? this.spawn() : undefined;
  }

  private start(slot: Slot, task: Task): void {
    slot.task = task;
    slot.worker.ref(); // a busy worker keeps the process alive until its task settles
    try {
      slot.worker.postMessage(task.request);
    } catch (error) {
      // DataCloneError: the payload held something that can't be copied to a thread (e.g. a function).
      this.release(slot);
      this.settle(task, () => task.reject(error));
    }
  }

  private release(slot: Slot): void {
    slot.task = undefined;
    slot.worker.unref(); // an idle worker must not stop the process from exiting
  }

  private spawn(): Slot {
    const worker = new Worker(WORKER_FILE, { resourceLimits: { maxOldGenerationSizeMb: this.maxWorkerMemoryMb } });
    worker.unref();
    const slot: Slot = { worker, task: undefined };
    this.slots.add(slot);

    worker.on("message", (response: TaskResponse) => {
      const task = slot.task;
      if (task === undefined || task.request.id !== response.id) return;
      this.release(slot);
      if (response.ok) this.settle(task, () => task.resolve(response.value));
      else this.settle(task, () => task.reject(toError(response.failure)));
      this.dispatch();
    });
    // An uncaught error inside the worker, including running out of memory, ends the thread.
    // "error" comes first with the reason; "exit" always follows.
    worker.on("error", (error) => this.lose(slot, new WorkerCrashedError(error.message, { cause: error })));
    worker.on("messageerror", (error) => this.lose(slot, new WorkerCrashedError(error.message, { cause: error })));
    worker.on("exit", (code) => this.lose(slot, new WorkerCrashedError(`thread exited with code ${code}`)));
    return slot;
  }

  /** A worker died on its own: fail its task, forget it, and replace it if work is waiting. */
  private lose(slot: Slot, error: WorkerCrashedError): void {
    if (!this.slots.delete(slot)) return; // already handled, or stopped on purpose
    const task = slot.task;
    slot.task = undefined;
    if (task !== undefined) this.settle(task, () => task.reject(error));
    void slot.worker.terminate(); // no-op if already gone; makes sure a half-broken thread stops
    if (!this.closed) this.dispatch();
  }

  /** Stops a worker on purpose. Removing it first means its "exit" event is ignored. */
  private retire(slot: Slot): Promise<number> {
    this.slots.delete(slot);
    slot.task = undefined;
    return slot.worker.terminate();
  }

  private cancel(task: Task): void {
    const waiting = this.queue.indexOf(task);
    if (waiting !== -1) {
      this.queue.splice(waiting, 1);
    } else {
      const slot = [...this.slots].find((candidate) => candidate.task === task);
      if (slot === undefined) return; // already settled
      // Synchronous JavaScript cannot be interrupted, so the only way to stop a running
      // simulation is to stop its thread. A replacement starts when work is waiting.
      void this.retire(slot);
      this.dispatch();
    }
    this.settle(task, () => task.reject(task.signal?.reason));
  }

  private rejectQueued(): void {
    for (const task of this.queue.splice(0)) this.settle(task, () => task.reject(new PoolClosedError()));
  }

  private settle(task: Task, complete: () => void): void {
    // Always detach: callers often share one long-lived signal across many tasks.
    task.signal?.removeEventListener("abort", task.onAbort);
    complete();
  }
}

function toError(failure: TaskFailure): unknown {
  if (failure.kind === "other") return failure.error;
  return reviveError(failure.data) ?? new Error(failure.data.message);
}

function positiveInteger(name: string, value: number, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`SimulationPool option "${name}" must be a whole number of at least ${minimum}, got ${value}`);
  }
  return value;
}
