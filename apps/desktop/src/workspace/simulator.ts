import { backendFor } from "../circuit/backend";
import { summaryOf, type Ws } from "./context";

/**
 * Runs the simulation, one step after another, never two at once: in sequential mode (a latch)
 * each step needs the state the previous one returned, and quick clicks must not overtake each
 * other. Each step asks whoever computes the open circuit (circuit/backend.ts), then colours the
 * drawing and fills the inspector from the answer.
 */
export interface Simulator {
  /** Simulates the circuit as it is now. `step`: a switch was flipped, which is one step of a latch. */
  run(step: boolean): void;
}

export function createSimulator(ws: Ws): Simulator {
  let queue: Promise<void> = Promise.resolve();
  return {
    run(step) {
      queue = queue.then(() => simulateOnce(ws, step));
    },
  };
}

async function simulateOnce(ws: Ws, step: boolean): Promise<void> {
  const { doc } = ws;
  if (ws.signal.aborted) return;
  if (doc.draft.gates.length === 0) {
    ws.last = null;
    ws.simStatus = { kind: "done", text: "Nothing to simulate yet." };
    ws.refresh("diagram", "inspector");
    return;
  }
  const sequential = summaryOf(ws).feedbackLoop !== null;
  const backend = backendFor(doc);
  try {
    const outcome = await backend.simulate(
      { inputs: { ...doc.inputs }, mode: sequential ? "sequential" : "combinational", ...(sequential && doc.state !== undefined && { state: doc.state }) },
      ws.signal,
    );
    ws.last = outcome;
    if (sequential) {
      doc.state = outcome.state;
      if (step) doc.steps += 1;
    }
    ws.simStatus = {
      kind: "done",
      text:
        backend.where === "server"
          ? outcome.fromCache === true
            ? "Answered from the server's cache: this exact question was asked before."
            : "Simulated by the server."
          : sequential
            ? `Step ${doc.steps} · simulated on this computer.`
            : "Simulated on this computer.",
    };
  } catch (error) {
    if (ws.signal.aborted) return;
    ws.last = null;
    ws.simStatus = { kind: "error", text: doc.dirty ? "Not simulated: the circuit isn't finished." : "Not simulated.", error };
  }
  ws.refresh("diagram", "inspector", "table");
}
