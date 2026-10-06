import type { Gate, Wire } from "@circuitlab/engine";

/**
 * What the screens show about a circuit: its inputs, its outputs, and a feedback loop if it has
 * one (a loop makes it "remember", so it is simulated step by step and has no truth table).
 *
 * The engine works this out too, but the window's code can't run the engine (it's built for
 * Node), and a drawing that is being edited changes with every click. So this is the same idea,
 * small: test/summary.test.ts checks it against the engine's answers.
 */
export interface Summary {
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** The gate ids around one loop, the first repeated at the end; null without a loop. */
  readonly feedbackLoop: readonly string[] | null;
}

export function summarize(gates: readonly Gate[], wires: readonly Wire[]): Summary {
  return {
    inputs: gates.filter((gate) => gate.type === "INPUT").map((gate) => gate.id),
    outputs: gates.filter((gate) => gate.type === "OUTPUT").map((gate) => gate.id),
    feedbackLoop: findLoop(gates, wires),
  };
}

/**
 * A loop in the wiring, found by a depth-first walk along the wires. Written with its own stack
 * instead of recursion, so a chain of 10,000 gates can't overflow the call stack.
 */
export function findLoop(gates: readonly Gate[], wires: readonly Wire[]): string[] | null {
  const next = new Map<string, string[]>(gates.map((gate) => [gate.id, []]));
  for (const wire of wires) {
    if (next.has(wire.to)) next.get(wire.from)?.push(wire.to);
  }
  const state = new Map<string, "open" | "done">();
  for (const gate of gates) {
    if (state.has(gate.id)) continue;
    // Each frame: a gate, and how many of its outgoing wires were followed already.
    const stack: { id: string; index: number }[] = [{ id: gate.id, index: 0 }];
    state.set(gate.id, "open");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1] as { id: string; index: number };
      const targets = next.get(frame.id) ?? [];
      if (frame.index >= targets.length) {
        state.set(frame.id, "done");
        stack.pop();
        continue;
      }
      const target = targets[frame.index++] as string;
      const seen = state.get(target);
      if (seen === "open") {
        // Back to a gate still on the path: the path from there is a loop.
        const path = stack.map((entry) => entry.id);
        return [...path.slice(path.indexOf(target)), target];
      }
      if (seen === undefined) {
        state.set(target, "open");
        stack.push({ id: target, index: 0 });
      }
    }
  }
  return null;
}

/** "5 gates, inputs A, B → outputs S, C." and what a loop means. */
export function describeSummary(summary: Summary, gates: number): string {
  const count = `${gates.toLocaleString()} gate${gates === 1 ? "" : "s"}`;
  const inputs = summary.inputs.length === 0 ? "no inputs" : `inputs ${summary.inputs.join(", ")}`;
  const outputs = summary.outputs.length === 0 ? "no outputs" : `outputs ${summary.outputs.join(", ")}`;
  const loop = summary.feedbackLoop === null ? "" : ` It has a feedback loop (${summary.feedbackLoop.join(" → ")}), so it's simulated step by step.`;
  return `${count}, ${inputs} → ${outputs}.${loop}`;
}
