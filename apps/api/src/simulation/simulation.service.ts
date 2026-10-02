import { createHash } from "node:crypto";
import {
  checkExpectedVersion,
  checkTruthTableAllowed,
  encodeTruthTable,
  runResource,
  simulationResponse,
  summarizeCircuit,
  toProblem,
  truthTableETag,
  truthTablePage,
  truthTableRange,
} from "@circuitlab/api-contract";
import type {
  CircuitRecord,
  SimulateRequest,
  SimulationResponse,
  SimulationRunList,
  TruthTableFormat,
  TruthTablePage,
  TruthTableQuery,
} from "@circuitlab/api-contract";
import { CircuitLabError, type ModeResult, type SimulationInputs, type SimulationMode, type TruthTable } from "@circuitlab/engine";
import { pack, unpack } from "@circuitlab/runner";
import { Injectable, Logger } from "@nestjs/common";
import type { AuthUser } from "../auth/auth-user";
import { Clock } from "../common/clock";
import { CircuitsService } from "../circuits/circuits.service";
import { isRedisUnavailable } from "../redis/redis-errors";
import { packRows, unpackRows } from "./packed-rows";
import { ResultCache } from "./result-cache";
import { RunsRepository, type NewRun } from "./runs.repository";
import { SimulationPoolService, type RowRange } from "./simulation-pool.service";

/** A truth-table download that has passed every check, ready to be computed. */
export interface TruthTablePlan {
  readonly record: CircuitRecord;
  readonly range: RowRange;
  readonly format: TruthTableFormat;
  readonly etag: string;
}

/** A JSON page of a truth table, checked against the circuit's access row only (not yet loaded). */
export interface PagePlan {
  readonly circuitId: string;
  readonly version: number;
  readonly expectedVersion: number | undefined;
  readonly range: RowRange;
  readonly etag: string;
}

/** Where an answer came from: the cache, or computed now (and kept for next time, or not). */
export type CacheOutcome = "hit" | "stored" | "miss";

/** The `Cache-Status` header (RFC 9211) for an outcome. */
export function cacheStatus(outcome: CacheOutcome): string {
  return { hit: "CircuitLab; hit", stored: "CircuitLab; fwd=miss; stored", miss: "CircuitLab; fwd=miss" }[outcome];
}

/**
 * Simulation use cases: load the circuit, run it on the shared worker pool, shape the answer.
 * Simulating needs read access only, so a viewer of a shared circuit, or anyone at all for a
 * public one, may simulate it.
 *
 * Simulation results and truth-table pages are cached (phase 10). A result depends only on the
 * circuit version and the request, and a version is never reused, so the version in the key is
 * the whole invalidation story. The access check always comes first, and needs only the circuit's
 * access row, which also holds its version: so a hit skips loading the gates and wires, the worker
 * threads, and the simulation itself, but never the question "may this caller see it?".
 */
@Injectable()
export class SimulationService {
  private readonly logger = new Logger(SimulationService.name);

  constructor(
    private readonly circuits: CircuitsService,
    private readonly pool: SimulationPoolService,
    private readonly runs: RunsRepository,
    private readonly cache: ResultCache,
    private readonly clock: Clock,
  ) {}

  /**
   * Runs one simulation, or finds its result in the cache, and records it: its outputs if it
   * succeeded, the problem code if the engine refused it (invalid inputs, a feedback loop). A
   * request turned away before running (pool busy, timeout) is not a run. Only successes are
   * cached; a refusal is cheap to repeat.
   */
  async simulate(
    id: string,
    request: SimulateRequest,
    includeSignals: boolean,
    signal: AbortSignal,
    user: AuthUser | undefined,
  ): Promise<{ readonly response: SimulationResponse; readonly cache: CacheOutcome }> {
    const startedAt = this.clock.now();
    const { facts } = await this.circuits.authorize(id, user, "read");
    const { inputs, mode, state } = request;
    const cached = await this.cached(simulationKey(id, facts.version, request));
    if (cached !== undefined) {
      const result = JSON.parse(cached) as ModeResult;
      // A cached success means these inputs were exactly the circuit's: nothing to filter.
      await this.record({ circuitId: id, version: facts.version, inputs, mode, user, startedAt }, { outputs: result.outputs });
      return { response: simulationResponse({ id, version: facts.version }, result, includeSignals), cache: "hit" };
    }

    const record = await this.circuits.get(id, user);
    const run = { circuitId: id, version: record.version, inputs: known(inputs, record), mode, user, startedAt };
    let result: ModeResult;
    try {
      result = await this.pool.simulate(record, inputs, { mode, ...(state !== undefined && { state }) }, signal);
    } catch (error) {
      if (error instanceof CircuitLabError) await this.record(run, { errorCode: toProblem(error).body.code });
      throw error;
    }
    await this.record(run, { outputs: result.outputs });
    const stored = await this.keep(simulationKey(id, record.version, request), JSON.stringify(result));
    return { response: simulationResponse(record, result, includeSignals), cache: stored ? "stored" : "miss" };
  }

  /**
   * A circuit's most recent runs, newest first. The owner sees everyone's (it's their circuit's
   * history); anyone else sees only their own, since others' inputs are none of their business.
   */
  async recentRuns(id: string, user: AuthUser, limit: number): Promise<SimulationRunList> {
    const { access } = await this.circuits.authorize(id, user, "read");
    const runs = await this.runs.recent(id, limit, access === "owner" ? undefined : user.id);
    return { items: runs.map(runResource) };
  }

  /**
   * The checks a JSON page needs before anything is computed or loaded: access, the version pin,
   * and the size of the page. Enough for the ETag, so a client whose copy is current gets its 304
   * without the circuit even being read.
   */
  async planPage(id: string, query: TruthTableQuery, user: AuthUser | undefined): Promise<PagePlan> {
    const { facts } = await this.circuits.authorize(id, user, "read");
    checkExpectedVersion(query.version, facts.version);
    // A JSON page's size doesn't depend on the table's: rows past its end are simply absent.
    const range = truthTableRange(query, Number.POSITIVE_INFINITY, "json");
    return { circuitId: id, version: facts.version, expectedVersion: query.version, range, etag: truthTableETag(facts.version, range.offset, range.limit, "json") };
  }

  /** One JSON page, from the cache or computed (and then cached). */
  async page(
    plan: PagePlan,
    user: AuthUser | undefined,
    basePath: string,
    signal: AbortSignal,
  ): Promise<{ readonly page: TruthTablePage; readonly etag: string; readonly cache: CacheOutcome }> {
    const shape = (version: number) => ({ circuitId: plan.circuitId, version, limit: plan.range.limit, basePath });
    const cached = await this.cached(pageKey(plan.circuitId, plan.version, plan.range));
    if (cached !== undefined) return { page: truthTablePage(decodePage(cached), shape(plan.version)), etag: plan.etag, cache: "hit" };

    // The circuit may have changed since the plan; the page is then of the version loaded now.
    const record = await this.circuits.get(plan.circuitId, user);
    checkExpectedVersion(plan.expectedVersion, record.version);
    checkTruthTableAllowed(record.summary);
    const table = await this.pool.truthTable(record, plan.range, signal);
    const stored = await this.keep(pageKey(plan.circuitId, record.version, plan.range), encodePage(table));
    return {
      page: truthTablePage(table, shape(record.version)),
      etag: truthTableETag(record.version, plan.range.offset, plan.range.limit, "json"),
      cache: stored ? "stored" : "miss",
    };
  }

  /**
   * Checks everything that can be checked before a single row of a download is computed: the
   * circuit exists and is still at the expected version, it has a truth table, and the range fits
   * the format. A problem found here gets a proper error response; one found halfway through a
   * download could only cut the connection.
   */
  async planTruthTable(id: string, query: TruthTableQuery, format: TruthTableFormat, user: AuthUser | undefined): Promise<TruthTablePlan> {
    const record = await this.circuits.get(id, user);
    checkExpectedVersion(query.version, record.version);
    const summary = summarizeCircuit(record);
    checkTruthTableAllowed(summary);
    const range = truthTableRange(query, 2 ** summary.inputs.length, format);
    return { record, range, format, etag: truthTableETag(record.version, range.offset, range.limit, format) };
  }

  /** CSV or NDJSON text, produced page by page only as fast as the client reads it. */
  download(plan: TruthTablePlan & { readonly format: "csv" | "ndjson" }): AsyncIterable<string> {
    return encodeTruthTable(this.pool.truthTablePages(plan.record, plan.range), plan.format);
  }

  /**
   * History is a side effect: if it can't be written, the simulation's answer still goes out, and
   * the failure is logged.
   */
  private async record(
    run: {
      readonly circuitId: string;
      readonly version: number;
      readonly inputs: SimulationInputs;
      readonly mode: SimulationMode;
      readonly user: AuthUser | undefined;
      readonly startedAt: Date;
    },
    outcome: NewRun["outcome"],
  ): Promise<void> {
    try {
      await this.runs.record({
        circuitId: run.circuitId,
        circuitVersion: run.version,
        userId: run.user?.id ?? null,
        mode: run.mode,
        inputs: run.inputs,
        outcome,
        startedAt: run.startedAt,
        finishedAt: this.clock.now(),
      });
    } catch (error) {
      this.logger.error(`Could not record a simulation of circuit ${run.circuitId}`, error instanceof Error ? error.stack : String(error));
    }
  }

  /**
   * The cache is an optimisation, so it can never fail a request: if it can't be read or written,
   * the answer is computed as if it were empty. (Redis outages are reported once, by RedisService.)
   */
  private async cached(key: string): Promise<string | undefined> {
    try {
      return await this.cache.get(key);
    } catch (error) {
      this.cacheFailed(error);
      return undefined;
    }
  }

  private async keep(key: string, value: string): Promise<boolean> {
    try {
      return await this.cache.set(key, value);
    } catch (error) {
      this.cacheFailed(error);
      return false;
    }
  }

  private cacheFailed(error: unknown): void {
    if (!isRedisUnavailable(error)) this.logger.warn(`The result cache failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Only the circuit's own inputs are kept in the history, so the size of a stored run is bounded by
 * the circuit, not by whatever a client sent.
 */
function known(inputs: SimulationInputs, record: CircuitRecord): SimulationInputs {
  const names = new Set(record.summary.inputs);
  return Object.fromEntries(Object.entries(inputs).filter(([name]) => names.has(name)));
}

/**
 * The cache key of a simulation: the circuit version, plus a hash of everything else the result
 * depends on. Keys are sorted first, so {A, B} and {B, A} are the same request. A missing state
 * and an empty one mean the same (every loop starts at 0).
 */
function simulationKey(circuitId: string, version: number, request: SimulateRequest): string {
  const sorted = (values: Readonly<Record<string, unknown>>) => Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = JSON.stringify([request.mode, sorted(request.inputs), sorted(request.state ?? {})]);
  return `sim:${circuitId}:${version}:${createHash("sha256").update(canonical).digest("base64url")}`;
}

function pageKey(circuitId: string, version: number, range: RowRange): string {
  return `page:${circuitId}:${version}:${range.offset}:${range.limit}`;
}

/** A page as cached: its shape, and its outputs one bit each (packed-rows.ts). 4,096 rows of 4 outputs are about 3 KB. */
function encodePage(table: TruthTable): string {
  const { offset, rowCount, bits } = packRows(pack(table));
  return JSON.stringify({ inputIds: table.inputIds, outputIds: table.outputIds, totalRows: table.totalRows, offset, rowCount, bits: bits.toString("base64") });
}

function decodePage(text: string): TruthTable {
  const page = JSON.parse(text) as { inputIds: string[]; outputIds: string[]; totalRows: number; offset: number; rowCount: number; bits: string };
  return unpack(unpackRows({ offset: page.offset, rowCount: page.rowCount, bits: Buffer.from(page.bits, "base64") }, page));
}
