import {
  LIMITS,
  isNotModified,
  parseListRunsQuery,
  parseSimulateQuery,
  parseSimulateRequest,
  parseTruthTableQuery,
  requestMediaType,
  responseMediaType,
  truthTableFormat,
} from "@circuitlab/api-contract";
import type { ListRunsQuery, SimulateQuery, SimulationResponse, SimulationRunList, TruthTableQuery } from "@circuitlab/api-contract";
import { Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { CurrentUser, OptionalUser, type AuthUser } from "../auth/auth-user";
import { ParseWith, RequestSignal, contentType, header, requestSignal, sendStream } from "../common/http";
import { SimulationService } from "./simulation.service";

/**
 * `/v1/circuits/{id}/simulate`, `/v1/circuits/{id}/truth-table`, and `/v1/circuits/{id}/runs`.
 * Simulating and truth tables work signed out for public circuits; the history needs a user.
 */
@Controller({ path: "circuits/:id", version: "1" })
export class SimulationController {
  constructor(private readonly simulation: SimulationService) {}

  @Post("simulate")
  @HttpCode(200) // Nest's default for POST is 201, but nothing is created
  async simulate(
    @Param("id") id: string,
    @Query(new ParseWith(parseSimulateQuery)) query: SimulateQuery,
    @OptionalUser() user: AuthUser | undefined,
    @Req() request: Request,
    @RequestSignal(LIMITS.simulationTimeoutMs) signal: AbortSignal,
  ): Promise<SimulationResponse> {
    requestMediaType("simulateCircuit", header(request.headers["content-type"]));
    return this.simulation.simulate(id, parseSimulateRequest(request.body), query.includeSignals, signal, user);
  }

  @Get("runs")
  runs(
    @Param("id") id: string,
    @Query(new ParseWith(parseListRunsQuery)) query: ListRunsQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<SimulationRunList> {
    return this.simulation.recentRuns(id, user, query.limit);
  }

  @Get("truth-table")
  async truthTable(
    @Param("id") id: string,
    @Query(new ParseWith(parseTruthTableQuery)) query: TruthTableQuery,
    @OptionalUser() user: AuthUser | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const mediaType = responseMediaType("getTruthTable", header(request.headers.accept));
    const plan = await this.simulation.planTruthTable(id, query, truthTableFormat(mediaType), user);
    response.vary("Accept").vary("Authorization").set("ETag", plan.etag);
    if (isNotModified(header(request.headers["if-none-match"]), plan.etag)) {
      response.status(304).end();
      return;
    }
    if (plan.format === "json") {
      response.json(await this.simulation.page(plan, request.path, requestSignal(response, LIMITS.simulationTimeoutMs)));
      return;
    }
    // A download has no time limit (it may be a million rows), but stops if the client goes away.
    response.type(contentType(mediaType));
    await sendStream(response, this.simulation.download({ ...plan, format: plan.format }));
  }
}
