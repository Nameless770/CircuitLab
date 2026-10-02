import type {
  AuthSession,
  CircuitInput,
  CircuitMetadataPatch,
  CircuitPage,
  CircuitResource,
  ListScope,
  Problem,
  RegisterRequest,
  ShareList,
  ShareResource,
  ShareRole,
  SignInRequest,
  SimulateRequest,
  SimulationResponse,
  SimulationRunList,
  TruthTableJobResource,
  TruthTablePage,
  ValidationReport,
} from "@circuitlab/api-contract";
import { clearSession, currentSession, saveSession } from "./session";

/**
 * Every call to the CircuitLab API goes through this file. The types come from
 * @circuitlab/api-contract, the same ones the server uses, so if the API changes shape,
 * TypeScript points at the code here that needs updating.
 *
 * Paths start with /v1. The main process (electron/main.ts) forwards them to the API at the
 * address in Settings.
 */

const NETLIST = "text/vnd.circuitlab.netlist";

/** The API answered with an error (an RFC 9457 "problem" document, when it's from the API itself). */
export class ApiError extends Error {
  readonly status: number;
  /** The problem's `code` (e.g. "not-found"), or "http-<status>" if the answer wasn't a problem document. */
  readonly code: string;
  readonly problem: Problem | null;
  /** Seconds, from the Retry-After header (busy server, too many attempts, unfinished job). */
  readonly retryAfter: number | null;

  constructor(status: number, code: string, message: string, problem: Problem | null, retryAfter: number | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.problem = problem;
    this.retryAfter = retryAfter;
  }
}

/** The request never got an answer: the API (or the dev server) isn't running, or there's no network. */
export class NetworkError extends Error {
  constructor() {
    super("Can't reach the CircuitLab API. Is it running? (npm run start:api)");
    this.name = "NetworkError";
  }
}

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** A body to send as JSON. */
  readonly json?: unknown;
  /** A body to send as text, e.g. a netlist. */
  readonly text?: string;
  /** Content-Type for `json` (default application/json) or `text`. */
  readonly contentType?: string;
  readonly accept?: string;
  /** The circuit's ETag as we last saw it. The API refuses (412) if someone changed it since. */
  readonly ifMatch?: string;
  /** Cancels the request, e.g. when the user leaves the page. */
  readonly signal?: AbortSignal;
}

/**
 * Sends a request and returns the response if it succeeded; otherwise throws ApiError or
 * NetworkError.
 *
 * Access tokens expire after 15 minutes. When the API says ours is no longer valid, we trade the
 * refresh token for new ones and try the request once more, so the user doesn't notice.
 */
export async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const response = await send(path, options);
  if (response.ok) return response;
  const error = await toApiError(response);
  if (error.code === "invalid-token" && currentSession() !== null && (await refreshSession())) {
    const retried = await send(path, options);
    if (retried.ok) return retried;
    throw await toApiError(retried);
  }
  throw error;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (options.json !== undefined) {
    body = JSON.stringify(options.json);
    headers["Content-Type"] = options.contentType ?? "application/json";
  } else if (options.text !== undefined) {
    body = options.text;
    headers["Content-Type"] = options.contentType ?? "text/plain";
  }
  if (options.accept !== undefined) headers["Accept"] = options.accept;
  if (options.ifMatch !== undefined) headers["If-Match"] = options.ifMatch;
  const session = currentSession();
  if (session !== null) headers["Authorization"] = `Bearer ${session.accessToken}`;

  try {
    return await fetch(path, { method: options.method ?? "GET", headers, body, signal: options.signal });
  } catch (error) {
    // Cancelled on purpose (the user left the page): let the caller see that, not a network error.
    if (options.signal?.aborted === true) throw error;
    throw new NetworkError();
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const retryAfter = Number(response.headers.get("Retry-After")) || null;
  if ((response.headers.get("Content-Type") ?? "").includes("json")) {
    try {
      const problem = (await response.json()) as Problem;
      if (typeof problem.code === "string") {
        return new ApiError(response.status, problem.code, problem.detail ?? problem.title, problem, retryAfter);
      }
    } catch {
      // Not JSON after all; fall through.
    }
  }
  // Not an answer from the API itself: something between us and the API (a reverse proxy, say)
  // failed. When the API can't be reached at all, the main process answers with a problem document.
  const message =
    response.status >= 500
      ? `The server answered ${response.status}. Is the API running, at the address in Settings?`
      : `The server answered ${response.status} ${response.statusText}.`;
  return new ApiError(response.status, `http-${response.status}`, message, null, retryAfter);
}

/**
 * A refresh token works only once: the API ends the whole session if one is used twice (it
 * assumes it was stolen). So when several requests find the access token expired at the same
 * moment, they must share ONE refresh instead of each starting their own. That's what
 * `refreshing` is for.
 */
let refreshing: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  refreshing ??= doRefresh().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

async function doRefresh(): Promise<boolean> {
  const session = currentSession();
  if (session === null) return false;
  try {
    const response = await fetch("/v1/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
    if (response.ok) {
      saveSession((await response.json()) as AuthSession);
      return true;
    }
    if (response.status === 401) clearSession(); // the session is over: sign in again
    return false;
  } catch {
    return false; // network trouble: keep the session, the next request may work
  }
}

async function json<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await request(path, { accept: "application/json", ...options });
  return (await response.json()) as T;
}

const circuitPath = (id: string): string => `/v1/circuits/${encodeURIComponent(id)}`;

// ---------------------------------------------------------------------------------------------
// Accounts

export async function register(body: RegisterRequest): Promise<void> {
  saveSession(await json<AuthSession>("/v1/auth/register", { method: "POST", json: body }));
}

export async function signIn(body: SignInRequest): Promise<void> {
  saveSession(await json<AuthSession>("/v1/auth/login", { method: "POST", json: body }));
}

/** Forgets the tokens here first, then tells the API to end the session (best effort). */
export async function signOut(): Promise<void> {
  const session = currentSession();
  clearSession();
  if (session === null) return;
  try {
    await fetch("/v1/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: session.refreshToken }),
    });
  } catch {
    // The API is unreachable; the refresh token expires on its own after 30 days unused.
  }
}

// ---------------------------------------------------------------------------------------------
// Circuits

export interface ListCircuitsOptions {
  readonly scope: ListScope;
  /** Only circuits whose name contains this. */
  readonly search?: string;
  /** From the previous page's `page.nextCursor`. */
  readonly cursor?: string;
  readonly signal?: AbortSignal;
}

export function listCircuits(options: ListCircuitsOptions): Promise<CircuitPage> {
  const params = new URLSearchParams({ scope: options.scope, limit: "20", sort: "-updatedAt" });
  if (options.search !== undefined && options.search !== "") params.set("q", options.search);
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  return json<CircuitPage>(`/v1/circuits?${params.toString()}`, { signal: options.signal });
}

/** A circuit together with its ETag, which later changes must send back (If-Match). */
export interface LoadedCircuit {
  readonly circuit: CircuitResource;
  readonly etag: string;
}

async function loaded(response: Response): Promise<LoadedCircuit> {
  return { circuit: (await response.json()) as CircuitResource, etag: response.headers.get("ETag") ?? "" };
}

export async function getCircuit(id: string, signal?: AbortSignal): Promise<LoadedCircuit> {
  return loaded(await request(circuitPath(id), { accept: "application/json", signal }));
}

export async function getNetlist(id: string, signal?: AbortSignal): Promise<string> {
  return (await request(circuitPath(id), { accept: NETLIST, signal })).text();
}

export async function createCircuit(input: CircuitInput): Promise<LoadedCircuit> {
  return loaded(await request("/v1/circuits", { method: "POST", json: input }));
}

/** The circuit's name comes from the netlist's `.name` line. */
export async function createCircuitFromNetlist(netlist: string): Promise<LoadedCircuit> {
  return loaded(await request("/v1/circuits", { method: "POST", text: netlist, contentType: NETLIST }));
}

/** Validates without storing anything (`dryRun=true`). Throws the same ApiError a real save would. */
export function checkCircuit(input: CircuitInput): Promise<ValidationReport> {
  return json<ValidationReport>("/v1/circuits?dryRun=true", { method: "POST", json: input });
}

export function checkNetlist(netlist: string): Promise<ValidationReport> {
  return json<ValidationReport>("/v1/circuits?dryRun=true", { method: "POST", text: netlist, contentType: NETLIST });
}

export async function replaceCircuit(id: string, input: CircuitInput, etag: string): Promise<LoadedCircuit> {
  return loaded(await request(circuitPath(id), { method: "PUT", json: input, ifMatch: etag }));
}

/**
 * Replacing a circuit replaces its description too, and a netlist has no place for one, so the
 * current description goes along as a query parameter (otherwise it would be erased).
 */
export async function replaceCircuitWithNetlist(id: string, netlist: string, description: string | undefined, etag: string): Promise<LoadedCircuit> {
  const query = description === undefined || description === "" ? "" : `?${new URLSearchParams({ description }).toString()}`;
  return loaded(await request(`${circuitPath(id)}${query}`, { method: "PUT", text: netlist, contentType: NETLIST, ifMatch: etag }));
}

/** Rename, change the description, or make public/private. */
export async function updateCircuit(id: string, patch: CircuitMetadataPatch, etag: string): Promise<LoadedCircuit> {
  return loaded(await request(circuitPath(id), { method: "PATCH", json: patch, contentType: "application/merge-patch+json", ifMatch: etag }));
}

export async function deleteCircuit(id: string, etag: string): Promise<void> {
  await request(circuitPath(id), { method: "DELETE", ifMatch: etag });
}

// ---------------------------------------------------------------------------------------------
// Simulation

export interface SimulationAnswer {
  readonly result: SimulationResponse;
  /** True when the API answered from its result cache (the Cache-Status header, phase 10). */
  readonly fromCache: boolean;
}

/** Always asks for `signals` (every gate's value), so the diagram can colour every wire. */
export async function simulate(id: string, body: SimulateRequest, signal?: AbortSignal): Promise<SimulationAnswer> {
  const response = await request(`${circuitPath(id)}/simulate?include=signals`, { method: "POST", json: body, accept: "application/json", signal });
  return {
    result: (await response.json()) as SimulationResponse,
    fromCache: (response.headers.get("Cache-Status") ?? "").includes("hit"),
  };
}

/** The first page, or any page from a previous page's `links` (those keep the circuit version fixed). */
export function truthTablePage(url: string, signal?: AbortSignal): Promise<TruthTablePage> {
  return json<TruthTablePage>(url, { signal });
}

export function firstTruthTablePageUrl(id: string, rowsPerPage: number, offset = 0): string {
  return `${circuitPath(id)}/truth-table?offset=${offset}&limit=${rowsPerPage}`;
}

/** The whole table as CSV (up to 1,048,576 rows; bigger ones need a background job). */
export async function downloadTruthTable(id: string): Promise<Blob> {
  return (await request(`${circuitPath(id)}/truth-table`, { accept: "text/csv" })).blob();
}

export function startTruthTableJob(id: string, version: number): Promise<TruthTableJobResource> {
  return json<TruthTableJobResource>(`${circuitPath(id)}/truth-table/jobs`, { method: "POST", json: { version } });
}

/** `jobUrl` is the job's `links.self`. */
export async function getJob(jobUrl: string, signal?: AbortSignal): Promise<{ job: TruthTableJobResource; retryAfter: number | null }> {
  const response = await request(jobUrl, { accept: "application/json", signal });
  return { job: (await response.json()) as TruthTableJobResource, retryAfter: Number(response.headers.get("Retry-After")) || null };
}

export async function cancelJob(jobUrl: string): Promise<void> {
  await request(jobUrl, { method: "DELETE" });
}

/** `resultUrl` is the job's `links.result`. */
export async function downloadJobResult(resultUrl: string): Promise<Blob> {
  return (await request(resultUrl, { accept: "text/csv" })).blob();
}

export function listRuns(id: string, signal?: AbortSignal): Promise<SimulationRunList> {
  return json<SimulationRunList>(`${circuitPath(id)}/runs?limit=20`, { signal });
}

// ---------------------------------------------------------------------------------------------
// Sharing

export function listShares(id: string, signal?: AbortSignal): Promise<ShareList> {
  return json<ShareList>(`${circuitPath(id)}/shares`, { signal });
}

/** Sharing again with the same person changes their role. */
export function shareCircuit(id: string, email: string, role: ShareRole): Promise<ShareResource> {
  return json<ShareResource>(`${circuitPath(id)}/shares`, { method: "POST", json: { email, role } });
}

export async function unshareCircuit(id: string, userId: string): Promise<void> {
  await request(`${circuitPath(id)}/shares/${encodeURIComponent(userId)}`, { method: "DELETE" });
}
