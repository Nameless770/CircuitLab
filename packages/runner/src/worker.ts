// Entry point of each worker thread started by SimulationPool. It runs one task at a time
// and always answers with a TaskResponse, so the pool never has to guess what happened.

import { parentPort, type TransferListItem } from "node:worker_threads";
import { CircuitLabError, compileCircuit, simulationStrategy, truthTable, type SimulationInputs, type SimulationState } from "@circuitlab/engine";
import { pack, type TaskFailure, type TaskRequest, type TaskResponse } from "./protocol";

const port = parentPort;
if (port === null) throw new Error("worker.js is started by SimulationPool; it cannot run on its own");

port.on("message", (request: TaskRequest) => {
  const { response, transfer } = handle(request);
  try {
    port.postMessage(response, transfer);
  } catch (cloneError) {
    // The thrown value itself could not be copied (e.g. it carried a function). Send the gist.
    const error = new Error(`Task failed with an error that cannot be sent between threads: ${String(cloneError)}`);
    port.postMessage({ id: request.id, ok: false, failure: { kind: "other", error } } satisfies TaskResponse);
  }
});

function handle(request: TaskRequest): { response: TaskResponse; transfer: TransferListItem[] } {
  try {
    const { value, transfer } = execute(request);
    return { response: { id: request.id, ok: true, value }, transfer };
  } catch (error) {
    return { response: { id: request.id, ok: false, failure: describe(error) }, transfer: [] };
  }
}

/** Runs the task. `transfer` lists buffers handed over to the main thread instead of copied. */
function execute(request: TaskRequest): { value: unknown; transfer: TransferListItem[] } {
  // The circuit arrives as plain data, so it goes through full validation here.
  switch (request.kind) {
    case "simulate":
      // The mode picks the strategy; every strategy is used the same way.
      return {
        value: simulationStrategy(request.mode).prepare(request.circuit).run(request.inputs as SimulationInputs, request.state as SimulationState | undefined),
        transfer: [],
      };
    case "truthTable": {
      const packed = pack(truthTable(compileCircuit(request.circuit), request.range));
      return { value: packed, transfer: [packed.outputs.buffer] };
    }
  }
}

function describe(error: unknown): TaskFailure {
  if (error instanceof CircuitLabError) return { kind: "engine", data: error.toJSON() };
  return { kind: "other", error };
}
