import {
  LIMITS,
  encodeTruthTable,
  isUnfinished,
  parseTruthTableJobRequest,
  requestMediaType,
  responseMediaType,
  truthTableFormat,
} from "@circuitlab/api-contract";
import type { TruthTableJobResource } from "@circuitlab/api-contract";
import { Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { CurrentUser, type AuthUser } from "../auth/auth-user";
import { contentType, header, sendStream } from "../common/http";
import { TruthTableJobsService } from "./truth-table-jobs.service";

/**
 * `/v1/circuits/{id}/truth-table/jobs`: background truth tables, following the asynchronous
 * request-reply pattern. POST answers 202 Accepted at once, with the job's URL in Location; the
 * client polls that URL (Retry-After says how often) and downloads the result when it's ready.
 */
@Controller({ path: "circuits/:id/truth-table/jobs", version: "1" })
export class TruthTableJobsController {
  constructor(private readonly jobs: TruthTableJobsService) {}

  @Post()
  @HttpCode(202)
  async create(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TruthTableJobResource> {
    requestMediaType("createTruthTableJob", header(request.headers["content-type"]));
    const job = await this.jobs.create(id, parseTruthTableJobRequest(request.body), user);
    response.location(job.links.self).set("Retry-After", String(LIMITS.retryAfterSeconds.jobPoll));
    return job;
  }

  @Get(":jobId")
  async get(
    @Param("id") id: string,
    @Param("jobId") jobId: string,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<TruthTableJobResource> {
    const job = await this.jobs.get(id, jobId, user);
    if (isUnfinished(job.status)) response.set("Retry-After", String(LIMITS.retryAfterSeconds.jobPoll));
    return job;
  }

  @Delete(":jobId")
  @HttpCode(204)
  async delete(@Param("id") id: string, @Param("jobId") jobId: string, @CurrentUser() user: AuthUser): Promise<void> {
    await this.jobs.delete(id, jobId, user);
  }

  /** CSV (the default) or NDJSON, streamed chunk by chunk as the client reads it. */
  @Get(":jobId/result")
  async result(
    @Param("id") id: string,
    @Param("jobId") jobId: string,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const mediaType = responseMediaType("getTruthTableJobResult", header(request.headers.accept));
    const format = truthTableFormat(mediaType) === "ndjson" ? "ndjson" : "csv";
    const { job, pages } = await this.jobs.result(id, jobId, user);
    response
      .vary("Accept")
      .type(contentType(mediaType))
      .set("Content-Disposition", `attachment; filename="truth-table-${job.id}.${format}"`);
    await sendStream(response, encodeTruthTable(pages, format));
  }
}
