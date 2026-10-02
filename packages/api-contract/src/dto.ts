// TypeScript mirrors of the schemas in openapi.yaml (same names, except where noted). The contract
// checks validate real responses against the spec, which keeps these honest.

import type { Bit, Gate, SimulationMode, TruthTableRow, Wire } from "@circuitlab/engine";

/** Schema `CircuitInput`: a circuit as a client sends it. */
export interface CircuitInput {
  readonly name: string;
  readonly description?: string;
  readonly gates: readonly Gate[];
  readonly wires: readonly Wire[];
}

/** Schema `CircuitMetadataPatch`: a JSON Merge Patch; `description: null` removes it. */
export interface CircuitMetadataPatch {
  readonly name?: string;
  readonly description?: string | null;
  /** Only the owner may change it. */
  readonly visibility?: Visibility;
}

/** Schema `Visibility`: who may see a circuit besides its owner and the people it is shared with. */
export type Visibility = "private" | "public";

/** Schema `ShareRole`: a viewer may read and simulate a circuit; an editor may also change it. */
export type ShareRole = "viewer" | "editor";

/** Schema `ListScope`: which circuits a list shows. */
export type ListScope = "owned" | "shared" | "public";

/** Schema `UserSummary`: how a person appears on other people's screens. */
export interface UserSummary {
  readonly id: string;
  readonly displayName: string;
}

export interface CircuitSummary {
  readonly gates: number;
  readonly wires: number;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  /** A loop of gate ids, first repeated at the end; null when there is none. */
  readonly feedbackLoop: readonly string[] | null;
}

export interface CircuitListItem {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly owner: UserSummary;
  readonly visibility: Visibility;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly summary: CircuitSummary;
}

/** Schema `Circuit` (renamed here to avoid clashing with the engine's `Circuit`). */
export interface CircuitResource extends CircuitListItem {
  readonly gates: readonly Gate[];
  readonly wires: readonly Wire[];
}

export interface CircuitPage {
  readonly items: readonly CircuitListItem[];
  readonly page: { readonly limit: number; readonly nextCursor: string | null };
  readonly links: { readonly self: string; readonly next: string | null };
}

export interface ValidationReport {
  readonly valid: true;
  readonly summary: CircuitSummary;
}

/** Schema `SimulateRequest`, with the default mode filled in. */
export interface SimulateRequest {
  readonly inputs: Readonly<Record<string, Bit>>;
  readonly mode: SimulationMode;
  /** Sequential mode: what the loops remembered from the previous step. */
  readonly state?: Readonly<Record<string, Bit>>;
}

export interface SimulationResponse {
  readonly circuitId: string;
  readonly circuitVersion: number;
  readonly mode: SimulationMode;
  readonly outputs: Readonly<Record<string, Bit>>;
  /** Sequential mode: what the loops settled to, for the next step. */
  readonly state?: Readonly<Record<string, Bit>>;
  readonly signals?: Readonly<Record<string, Bit>>;
  readonly order?: readonly string[];
}

export interface TruthTablePage {
  readonly circuitId: string;
  readonly circuitVersion: number;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly totalRows: number;
  readonly offset: number;
  readonly limit: number;
  readonly rows: readonly TruthTableRow[];
  readonly links: {
    readonly self: string;
    readonly first: string;
    readonly prev: string | null;
    readonly next: string | null;
    readonly last: string;
  };
}

/** Schema `SimulationRun`. */
export interface SimulationRunResource {
  readonly id: string;
  readonly circuitVersion: number;
  readonly kind: "simulate" | "truth_table";
  readonly mode: SimulationMode;
  readonly status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly inputs?: Readonly<Record<string, unknown>>;
  readonly outputs?: Readonly<Record<string, Bit>>;
  /** Truth-table jobs: which rows. */
  readonly offset?: number;
  readonly limit?: number;
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly finishedAt?: string;
}

export type RunStatus = SimulationRunResource["status"];

/** Schema `TruthTableJobRequest`, with the defaults filled in except `limit` ("to the end"). */
export interface TruthTableJobRequest {
  readonly offset: number;
  readonly limit?: number;
  /** Refuse (409) unless the circuit is still at this version. */
  readonly version?: number;
}

/** Schema `TruthTableJob`. */
export interface TruthTableJobResource {
  readonly id: string;
  readonly circuitId: string;
  readonly circuitVersion: number;
  readonly status: RunStatus;
  readonly offset: number;
  /** Rows in this job. */
  readonly limit: number;
  readonly rowsDone: number;
  /** The problem code it failed with. */
  readonly errorCode?: string;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** Until when the result can be downloaded. */
  readonly expiresAt?: string;
  readonly links: { readonly self: string; readonly circuit: string; readonly result?: string };
}

/** Schema `SimulationRunList`. */
export interface SimulationRunList {
  readonly items: readonly SimulationRunResource[];
}

/** Schema `TruthTableStreamRow`: one NDJSON line. */
export interface TruthTableStreamRow {
  readonly index: number;
  readonly inputs: Readonly<Record<string, Bit>>;
  readonly outputs: Readonly<Record<string, Bit>>;
}

/** Schema `RegisterRequest`. */
export interface RegisterRequest {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
}

/** Schema `SignInRequest`. */
export interface SignInRequest {
  readonly email: string;
  readonly password: string;
}

/** Schema `RefreshRequest`: also the body of signing out. */
export interface RefreshRequest {
  readonly refreshToken: string;
}

/** Schema `User`: an account, as its owner sees it. */
export interface UserResource extends UserSummary {
  readonly email: string;
  readonly createdAt: string;
}

/** Schema `AuthSession`: the answer to registering, signing in, and refreshing. */
export interface AuthSession {
  readonly tokenType: "Bearer";
  /** A JWT to send as `Authorization: Bearer <accessToken>`. */
  readonly accessToken: string;
  /** Seconds until the access token expires. */
  readonly expiresIn: number;
  /** Exchanged for a new pair at /auth/refresh; each one works once. */
  readonly refreshToken: string;
  readonly user: UserResource;
}

/** Schema `ShareRequest`. */
export interface ShareRequest {
  readonly email: string;
  readonly role: ShareRole;
}

/** Schema `Share`. */
export interface ShareResource {
  readonly user: UserSummary & { readonly email: string };
  readonly role: ShareRole;
  readonly createdAt: string;
}

/** Schema `ShareList`. */
export interface ShareList {
  readonly items: readonly ShareResource[];
}
