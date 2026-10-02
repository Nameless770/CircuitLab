import type { DesktopBridge, LocalProblem, LocalResult } from "../electron/bridge";

declare global {
  interface Window {
    /** Set by electron/preload.ts. Missing when the code runs in a normal browser tab. */
    circuitlab?: DesktopBridge;
  }
}

/** The main process's functions, or null outside the desktop app (e.g. Vite's page opened in a browser). */
export function desktop(): DesktopBridge | null {
  return window.circuitlab ?? null;
}

export function requireDesktop(): DesktopBridge {
  const bridge = desktop();
  if (bridge === null) throw new Error("Offline mode works in the CircuitLab desktop app (npm run dev:desktop), not in a browser tab.");
  return bridge;
}

/** An error from offline mode, described by the main process. Shown like an API error (see ui.ts). */
export class LocalError extends Error {
  readonly problem: LocalProblem;

  constructor(problem: LocalProblem) {
    super(problem.message);
    this.name = "LocalError";
    this.problem = problem;
  }
}

/** The value of a main-process call, or its problem thrown as a LocalError. */
export function unwrap<T>(result: LocalResult<T>): T {
  if (result.ok) return result.value;
  throw new LocalError(result.problem);
}
