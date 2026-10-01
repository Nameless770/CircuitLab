import { CycleError, topologicalSort, type Bit, type Circuit, type ModeResult, type SimulationMode } from "@circuitlab/engine";
import type {
  AuthSession,
  CircuitListItem,
  CircuitResource,
  CircuitSummary,
  ShareResource,
  ShareRole,
  SimulationResponse,
  SimulationRunResource,
  UserResource,
  UserSummary,
  ValidationReport,
  Visibility,
} from "./dto";

/**
 * A stored circuit without its gates and wires: everything a list page needs. The summary is
 * computed once, when the circuit is written (summarizeCircuit), and stored with it.
 */
export interface CircuitHeader {
  readonly id: string;
  /** Starts at 1 and goes up by one with every change; also the ETag. */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly name: string;
  readonly description: string | null;
  readonly owner: UserSummary;
  readonly visibility: Visibility;
  readonly summary: CircuitSummary;
}

/** A whole stored circuit, as the storage layer hands it over: an engine `Circuit` plus the API's metadata. */
export interface CircuitRecord extends CircuitHeader, Circuit {
  readonly name: string;
}

/** What a client needs to know about a circuit before using it. The circuit must be valid. */
export function summarizeCircuit(circuit: Circuit): CircuitSummary {
  const ids = (type: string): string[] => circuit.gates.filter((gate) => gate.type === type).map((gate) => gate.id);
  let feedbackLoop: readonly string[] | null = null;
  try {
    topologicalSort(circuit);
  } catch (error) {
    if (!(error instanceof CycleError)) throw error;
    feedbackLoop = error.cycle;
  }
  return { gates: circuit.gates.length, wires: circuit.wires.length, inputs: ids("INPUT"), outputs: ids("OUTPUT"), feedbackLoop };
}

export function circuitListItem(header: CircuitHeader): CircuitListItem {
  return {
    id: header.id,
    name: header.name,
    ...(header.description !== null && { description: header.description }),
    owner: { id: header.owner.id, displayName: header.owner.displayName },
    visibility: header.visibility,
    version: header.version,
    createdAt: header.createdAt.toISOString(),
    updatedAt: header.updatedAt.toISOString(),
    summary: header.summary,
  };
}

export function circuitResource(record: CircuitRecord): CircuitResource {
  return { ...circuitListItem(record), gates: record.gates, wires: record.wires };
}

/** The answer to a dry run that passed. */
export function validationReport(circuit: Circuit): ValidationReport {
  return { valid: true, summary: summarizeCircuit(circuit) };
}

export function simulationResponse(record: Pick<CircuitRecord, "id" | "version">, result: ModeResult, includeSignals: boolean): SimulationResponse {
  return {
    circuitId: record.id,
    circuitVersion: record.version,
    mode: result.mode,
    outputs: result.outputs,
    ...(result.mode === "sequential" && { state: result.state }),
    ...(includeSignals && { signals: result.signals }),
    ...(includeSignals && result.mode === "combinational" && { order: result.order }),
  };
}

/** A recorded simulation, as the storage layer hands it over. */
export interface RunRecord {
  readonly id: string;
  readonly circuitVersion: number;
  readonly kind: "simulate" | "truth_table";
  readonly mode: SimulationMode;
  readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  /** As sent, so possibly invalid when the run failed. */
  readonly inputs: Readonly<Record<string, unknown>> | null;
  readonly outputs: Readonly<Record<string, Bit>> | null;
  /** The problem code the API answered with, when the run failed. */
  readonly errorCode: string | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
}

export function runResource(run: RunRecord): SimulationRunResource {
  return {
    id: run.id,
    circuitVersion: run.circuitVersion,
    kind: run.kind,
    mode: run.mode,
    status: run.status,
    ...(run.inputs !== null && { inputs: run.inputs }),
    ...(run.outputs !== null && { outputs: run.outputs }),
    ...(run.errorCode !== null && { errorCode: run.errorCode }),
    createdAt: run.createdAt.toISOString(),
    ...(run.finishedAt !== null && { finishedAt: run.finishedAt.toISOString() }),
  };
}

/** An account, as the storage layer hands it over (never with its password hash). */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly createdAt: Date;
}

export function userResource(user: UserRecord): UserResource {
  return { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt.toISOString() };
}

/** A circuit's share with one person, as the storage layer hands it over. */
export interface ShareRecord {
  readonly user: UserSummary & { readonly email: string };
  readonly role: ShareRole;
  readonly createdAt: Date;
}

export function shareResource(share: ShareRecord): ShareResource {
  return {
    user: { id: share.user.id, displayName: share.user.displayName, email: share.user.email },
    role: share.role,
    createdAt: share.createdAt.toISOString(),
  };
}

export function authSession(tokens: { readonly accessToken: string; readonly expiresIn: number; readonly refreshToken: string }, user: UserRecord): AuthSession {
  return { tokenType: "Bearer", accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, refreshToken: tokens.refreshToken, user: userResource(user) };
}
