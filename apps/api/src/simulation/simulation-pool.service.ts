import type { Circuit, ModeResult, SimulationInputs, SimulationMode, SimulationState, TruthTable } from "@circuitlab/engine";
import { SimulationPool, type PoolStats } from "@circuitlab/runner";
import { Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { AppConfig } from "../config/app-config";

export interface RowRange {
  readonly offset: number;
  readonly limit: number;
}

/**
 * The app's one pool of simulation worker threads (phase 2), shared by every request. Nest
 * providers are singletons, so every service that injects this gets the same pool.
 *
 * Only a circuit's gates and wires are sent to a worker: they are all the engine needs, and
 * everything sent is copied between threads.
 *
 * The pool itself is made by SimulationModule (`createSimulationPool`) and injected, rather than
 * constructed here: this service uses a pool and manages its shutdown, but doesn't decide how one
 * is built.
 */
@Injectable()
export class SimulationPoolService implements OnApplicationShutdown {
  private readonly logger = new Logger(SimulationPoolService.name);
  constructor(
    private readonly pool: SimulationPool,
    private readonly config: AppConfig,
  ) {}

  /** One simulation, in the given mode; the worker picks the engine's strategy for it. */
  simulate(circuit: Circuit, inputs: SimulationInputs, how: { readonly mode: SimulationMode; readonly state?: SimulationState }, signal: AbortSignal): Promise<ModeResult> {
    return this.pool.simulate(essentials(circuit), inputs, { mode: how.mode, ...(how.state !== undefined && { state: how.state }), signal });
  }

  truthTable(circuit: Circuit, range: RowRange, signal: AbortSignal): Promise<TruthTable> {
    return this.pool.truthTable(essentials(circuit), range, { signal });
  }

  /** Pages computed in parallel on the workers and yielded in order; see SimulationPool.truthTablePages. */
  truthTablePages(circuit: Circuit, range: RowRange): AsyncGenerator<TruthTable, void, undefined> {
    return this.pool.truthTablePages(essentials(circuit), range);
  }

  get stats(): PoolStats & { readonly size: number } {
    return { size: this.pool.size, ...this.pool.stats };
  }

  /**
   * Nest calls this on SIGTERM or SIGINT (with enableShutdownHooks) after the HTTP server has
   * stopped taking requests and drained the ones in flight. Running simulations get
   * `shutdownGraceMs` to finish; after that they are stopped, so a stuck task can never keep the
   * process from exiting.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    const { busy, queued } = this.pool.stats;
    this.logger.log(`Closing the simulation pool (${signal ?? "app closed"}; ${busy} running, ${queued} waiting)`);
    const deadline = setTimeout(() => {
      this.logger.warn(`Simulations still running after ${this.config.shutdownGraceMs} ms; stopping them`);
      void this.pool.destroy();
    }, this.config.shutdownGraceMs);
    try {
      await this.pool.close();
    } finally {
      clearTimeout(deadline);
    }
  }
}

/** The pool, as SimulationModule provides it: sized from the configuration. */
export function createSimulationPool(config: AppConfig): SimulationPool {
  return new SimulationPool({
    ...(config.simulationWorkers !== undefined && { size: config.simulationWorkers }),
    maxQueue: config.simulationQueue,
    maxWorkerMemoryMb: config.workerMemoryMb,
  });
}

function essentials(circuit: Circuit): Circuit {
  return { gates: circuit.gates, wires: circuit.wires };
}
