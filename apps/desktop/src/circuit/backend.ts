import type { CircuitResource } from "@circuitlab/api-contract";
import type { Bit, Gate, SimulationMode, Wire } from "@circuitlab/engine";
import { downloadTruthTable, firstTruthTablePageUrl, simulate, truthTablePage } from "../api";
import { requireDesktop, unwrap } from "../desktop";
import { fileNameFor, saveFile } from "../dom";
import type { LocalDocument } from "../offline/document";

/**
 * The simulator and the truth table work the same for a circuit on the server and for a
 * netlist file on this computer. Only *who computes* differs: the API, or the main process.
 * This interface is that difference; onlineBackend() and offlineBackend() are its two versions.
 */
export interface CircuitBackend {
  simulate(request: SimulationRequest, signal: AbortSignal): Promise<SimulationOutcome>;
  truthTablePage(offset: number, limit: number, signal: AbortSignal): Promise<TruthTableWindow>;
  /** Saves the whole truth table as CSV. Resolves to a message for the user, or null if cancelled. */
  exportCsv(): Promise<string | null>;
}

/** What both kinds of circuit have, and all the simulator and the truth table need. */
export interface ViewableCircuit {
  readonly name: string;
  readonly gates: readonly Gate[];
  readonly wires: readonly Wire[];
  readonly summary: {
    readonly inputs: readonly string[];
    readonly outputs: readonly string[];
    readonly feedbackLoop: readonly string[] | null;
  };
}

export interface SimulationRequest {
  readonly inputs: Readonly<Record<string, Bit>>;
  readonly mode: SimulationMode;
  readonly state?: Readonly<Record<string, Bit>>;
}

export interface SimulationOutcome {
  readonly outputs: Readonly<Record<string, Bit>>;
  readonly signals: Readonly<Record<string, Bit>>;
  readonly state?: Readonly<Record<string, Bit>>;
  /** Online only: whether the API answered from its cache. */
  readonly fromCache?: boolean;
}

export interface TruthTableWindow {
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly totalRows: number;
  readonly offset: number;
  readonly rows: readonly { readonly index: number; readonly inputs: readonly Bit[]; readonly outputs: readonly Bit[] }[];
}

export function onlineBackend(circuit: CircuitResource): CircuitBackend {
  return {
    async simulate(request, signal) {
      const { result, fromCache } = await simulate(circuit.id, request, signal);
      return { outputs: result.outputs, signals: result.signals ?? {}, ...(result.state !== undefined && { state: result.state }), fromCache };
    },
    truthTablePage(offset, limit, signal) {
      // `version` makes the API refuse (409) if the circuit changed while we're paging through it.
      return truthTablePage(`${firstTruthTablePageUrl(circuit.id, limit, offset)}&version=${circuit.version}`, signal);
    },
    async exportCsv() {
      saveFile(await downloadTruthTable(circuit.id), `${fileNameFor(circuit.name)}-truth-table.csv`);
      return "Download started.";
    },
  };
}

export function offlineBackend(document: LocalDocument): CircuitBackend {
  const { name, gates, wires } = document.circuit;
  const data = { name, gates, wires };
  return {
    async simulate(request) {
      return unwrap(await requireDesktop().simulate(data, request));
    },
    async truthTablePage(offset, limit) {
      return unwrap(await requireDesktop().truthTable(data, offset, limit));
    },
    async exportCsv() {
      const path = unwrap(await requireDesktop().exportTruthTable(data, `${fileNameFor(name)}-truth-table`));
      return path === null ? null : `Saved to ${path}`;
    },
  };
}
