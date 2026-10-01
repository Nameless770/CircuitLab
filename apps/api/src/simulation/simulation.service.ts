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
import { CircuitLabError, type ModeResult, type SimulationInputs, type SimulationMode } from "@circuitlab/engine";
import { Injectable, Logger } from "@nestjs/common";
import type { AuthUser } from "../auth/auth-user";
import { Clock } from "../common/clock";
import { CircuitsService } from "../circuits/circuits.service";
import { RunsRepository, type NewRun } from "./runs.repository";
import { SimulationPoolService, type RowRange } from "./simulation-pool.service";

/** A truth-table request that has passed every check, ready to be computed. */
export interface TruthTablePlan {
  readonly record: CircuitRecord;
  readonly range: RowRange;
  readonly format: TruthTableFormat;
  readonly etag: string;
}

/**
 * Simulation use cases: load the circuit, run it on the shared worker pool, shape the answer.
 * Simulating needs read access only, so a viewer of a shared circuit, or anyone at all for a
 * public one, may simulate it.
 */
@Injectable()
export class SimulationService {
  private readonly logger = new Logger(SimulationService.name);

  constructor(
    private readonly circuits: CircuitsService,
    private readonly pool: SimulationPoolService,
    private readonly runs: RunsRepository,
    private readonly clock: Clock,
  ) {}

  /**
   * Runs one simulation and records it: its outputs if it succeeded, the problem code if the engine
   * refused it (invalid inputs, a feedback loop). A request turned away before running (pool busy,
   * timeout) is not a run.
   */
  async simulate(
    id: string,
    request: SimulateRequest,
    includeSignals: boolean,
    signal: AbortSignal,
    user: AuthUser | undefined,
  ): Promise<SimulationResponse> {
    const record = await this.circuits.get(id, user);
    const { inputs, mode, state } = request;
    const run = { record, inputs, mode, user, startedAt: this.clock.now() };
    let result: ModeResult;
    try {
      result = await this.pool.simulate(record, inputs, { mode, ...(state !== undefined && { state }) }, signal);
    } catch (error) {
      if (error instanceof CircuitLabError) await this.record(run, { errorCode: toProblem(error).body.code });
      throw error;
    }
    await this.record(run, { outputs: result.outputs });
    return simulationResponse(record, result, includeSignals);
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
   * Checks everything that can be checked before a single row is computed: the circuit exists and
   * is still at the expected version, it has a truth table, and the range fits the format. A
   * problem found here gets a proper error response; one found halfway through a download could
   * only cut the connection.
   */
  async planTruthTable(id: string, query: TruthTableQuery, format: TruthTableFormat, user: AuthUser | undefined): Promise<TruthTablePlan> {
    const record = await this.circuits.get(id, user);
    checkExpectedVersion(query.version, record.version);
    const summary = summarizeCircuit(record);
    checkTruthTableAllowed(summary);
    const range = truthTableRange(query, 2 ** summary.inputs.length, format);
    return { record, range, format, etag: truthTableETag(record.version, range.offset, range.limit, format) };
  }

  async page(plan: TruthTablePlan, basePath: string, signal: AbortSignal): Promise<TruthTablePage> {
    const table = await this.pool.truthTable(plan.record, plan.range, signal);
    return truthTablePage(table, { circuitId: plan.record.id, version: plan.record.version, limit: plan.range.limit, basePath });
  }

  /** CSV or NDJSON text, produced page by page only as fast as the client reads it. */
  download(plan: TruthTablePlan & { readonly format: "csv" | "ndjson" }): AsyncIterable<string> {
    return encodeTruthTable(this.pool.truthTablePages(plan.record, plan.range), plan.format);
  }

  /**
   * History is a side effect: if it can't be written, the simulation's answer still goes out, and
   * the failure is logged. Only the circuit's own inputs are kept, so the size of a stored run is
   * bounded by the circuit, not by whatever a client sent.
   */
  private async record(
    run: { readonly record: CircuitRecord; readonly inputs: SimulationInputs; readonly mode: SimulationMode; readonly user: AuthUser | undefined; readonly startedAt: Date },
    outcome: NewRun["outcome"],
  ): Promise<void> {
    const { record, inputs, mode, user, startedAt } = run;
    const known = new Set(record.summary.inputs);
    try {
      await this.runs.record({
        circuitId: record.id,
        circuitVersion: record.version,
        userId: user?.id ?? null,
        mode,
        inputs: Object.fromEntries(Object.entries(inputs).filter(([name]) => known.has(name))),
        outcome,
        startedAt,
        finishedAt: this.clock.now(),
      });
    } catch (error) {
      this.logger.error(`Could not record a simulation of circuit ${record.id}`, error instanceof Error ? error.stack : String(error));
    }
  }
}
