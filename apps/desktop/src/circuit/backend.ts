import type { CircuitResource } from "@circuitlab/api-contract";
import type { Bit, SimulationMode } from "@circuitlab/engine";
import type { CircuitData } from "../../electron/bridge";
import { downloadTruthTable, firstTruthTablePageUrl, simulate, truthTablePage } from "../api";
import { desktop, requireDesktop, unwrap } from "../desktop";
import { fileNameFor, saveFile } from "../dom";
import { Notice } from "../ui";
import type { OpenDoc } from "../workspace/store";

/**
 * The simulator and the truth table work the same for a circuit on the server and for one on
 * this computer. Only *who computes* differs: the API, or the main process (the engine, offline).
 * This interface is that difference; onlineBackend() and localBackend() are its two versions.
 */
export interface CircuitBackend {
  /** "server" when the API computes, "local" when this computer does. */
  readonly where: "server" | "local";
  simulate(request: SimulationRequest, signal: AbortSignal): Promise<SimulationOutcome>;
  truthTablePage(offset: number, limit: number, signal: AbortSignal): Promise<TruthTableWindow>;
  /** Saves the whole truth table as CSV. Resolves to a message for the user, or null if cancelled. */
  exportCsv(): Promise<string | null>;
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

/**
 * Who computes the open circuit: the server for a circuit on the server, as it is saved there.
 * Anything else (and a server circuit with unsaved changes, which the server hasn't got) is
 * computed on this computer.
 */
export function backendFor(doc: OpenDoc): CircuitBackend {
  if (doc.source.kind === "server" && !doc.dirty && doc.server !== undefined) return onlineBackend(doc.server.circuit);
  if (desktop() === null) return unavailableBackend();
  return localBackend({ name: doc.draft.name.trim() || "Untitled circuit", gates: doc.draft.gates, wires: doc.draft.wires });
}

export function onlineBackend(circuit: CircuitResource): CircuitBackend {
  return {
    where: "server",
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

export function localBackend(data: CircuitData): CircuitBackend {
  return {
    where: "local",
    async simulate(request) {
      return unwrap(await requireDesktop().simulate(data, request));
    },
    async truthTablePage(offset, limit) {
      return unwrap(await requireDesktop().truthTable(data, offset, limit));
    },
    async exportCsv() {
      const path = unwrap(await requireDesktop().exportTruthTable(data, `${fileNameFor(data.name)}-truth-table`));
      return path === null ? null : `Saved to ${path}`;
    },
  };
}

/** In a browser tab (development) there is no engine for unsaved circuits. */
function unavailableBackend(): CircuitBackend {
  const fail = (): never => {
    throw new Notice("Simulating a circuit that isn't saved on the server needs the desktop app.");
  };
  return { where: "local", simulate: async () => fail(), truthTablePage: async () => fail(), exportCsv: async () => fail() };
}
