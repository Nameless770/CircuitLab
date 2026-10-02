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
import { SimulationService, cacheStatus } from "./simulation.service";

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
    @Res({ passthrough: true }) response: Response,
    @RequestSignal(LIMITS.simulationTimeoutMs) signal: AbortSignal,
  ): Promise<SimulationResponse> {
    requestMediaType("simulateCircuit", header(request.headers["content-type"]));
    const answer = await this.simulation.simulate(id, parseSimulateRequest(request.body), query.includeSignals, signal, user);
    response.set("Cache-Status", cacheStatus(answer.cache));
    return answer.response;
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
    const format = truthTableFormat(mediaType);
    response.vary("Accept").vary("Authorization");
    if (format === "json") {
      // A page is cached; its plan only reads the circuit's access row, which is all a 304 needs.
      const plan = await this.simulation.planPage(id, query, user);
      response.set("ETag", plan.etag);
      if (isNotModified(header(request.headers["if-none-match"]), plan.etag)) {
        response.status(304).end();
        return;
      }
      const answer = await this.simulation.page(plan, user, request.path, requestSignal(response, LIMITS.simulationTimeoutMs));
      response.set("ETag", answer.etag).set("Cache-Status", cacheStatus(answer.cache)).json(answer.page);
      return;
    }
    const plan = await this.simulation.planTruthTable(id, query, format, user);
    response.set("ETag", plan.etag);
    if (isNotModified(header(request.headers["if-none-match"]), plan.etag)) {
      response.status(304).end();
      return;
    }
    // A download has no time limit (it may be a million rows), but stops if the client goes away.
    response.type(contentType(mediaType));
    await sendStream(response, this.simulation.download({ ...plan, format }));
  }
}
