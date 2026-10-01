/**
 * Base class for problems with the pool itself, as opposed to problems with a circuit (those are
 * the engine's CircuitLabError subclasses, which pass through the pool unchanged).
 */
export abstract class PoolError extends Error {}

/** The pool was closed before this task could run. */
export class PoolClosedError extends PoolError {
  override readonly name = "PoolClosedError";

  constructor() {
    super("The simulation pool is closed");
  }
}

/** Every worker is busy and the waiting queue is full. Callers should back off and retry. */
export class PoolBusyError extends PoolError {
  override readonly name = "PoolBusyError";

  constructor(queued: number) {
    super(`Every simulation worker is busy and ${queued} tasks are already waiting`);
  }
}

/**
 * The worker thread died while running this task, for example because the task used more
 * memory than the worker is allowed. Only that task fails; the pool replaces the worker.
 */
export class WorkerCrashedError extends PoolError {
  override readonly name = "WorkerCrashedError";

  constructor(detail: string, options?: ErrorOptions) {
    super(`The simulation worker stopped unexpectedly: ${detail}`, options);
  }
}
