import {
  MEDIA_TYPES,
  circuitETag,
  circuitResource,
  isNotModified,
  linkHeader,
  parseListCircuitsQuery,
  parseMetadataPatch,
  requestMediaType,
  responseMediaType,
  validationReport,
} from "@circuitlab/api-contract";
import type { CircuitPage, CircuitResource, ListCircuitsQuery } from "@circuitlab/api-contract";
import { formatNetlist } from "@circuitlab/netlist";
import { Controller, Delete, Get, Headers, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { CurrentUser, OptionalUser, type AuthUser } from "../auth/auth-user";
import { ParseWith, contentType, header, sendStream } from "../common/http";
import { readCircuitBody } from "./circuit-body";
import { CircuitsService } from "./circuits.service";

/**
 * `/v1/circuits`: translates between HTTP and CircuitsService. Validation, content negotiation,
 * and ETags come from @circuitlab/api-contract. @CurrentUser() marks the handlers that need a
 * signed-in user (401 without one); @OptionalUser() those that also serve public circuits to anyone.
 *
 * Most handlers return their result and let Nest send it. The ones whose status depends on the
 * request (201 or 200 for a dry run; 200 or 304) take the response object instead, because Nest
 * applies one fixed status per route to returned values.
 */
@Controller({ path: "circuits", version: "1" })
export class CircuitsController {
  constructor(private readonly circuits: CircuitsService) {}

  @Get()
  async list(
    @Query(new ParseWith(parseListCircuitsQuery)) query: ListCircuitsQuery,
    @OptionalUser() user: AuthUser | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CircuitPage> {
    const page = await this.circuits.list(query, user, request.path);
    if (page.links.next !== null) response.set("Link", linkHeader({ next: page.links.next }));
    return page;
  }

  @Post()
  async create(@CurrentUser() user: AuthUser, @Req() request: Request, @Res() response: Response): Promise<void> {
    const { input, query } = await readCircuitBody("createCircuit", request);
    if (query.dryRun) {
      response.status(200).json(validationReport(input));
      return;
    }
    const record = await this.circuits.create(input, user);
    response
      .status(201)
      .set({ Location: `${request.path}/${record.id}`, ETag: circuitETag(record.version) })
      .json(circuitResource(record));
  }

  @Get(":id")
  async get(
    @Param("id") id: string,
    @OptionalUser() user: AuthUser | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const mediaType = responseMediaType("getCircuit", header(request.headers.accept));
    const form = mediaType === MEDIA_TYPES.netlist ? "netlist" : "json";
    // Whether the client's copy is current depends on the version alone, which the access check
    // reads anyway (and a stranger gets a 404 from it, never a 304). So a 304 doesn't load the
    // gates and wires, which for a big circuit was most of the work (docs/system-design.md).
    const { facts } = await this.circuits.authorize(id, user, "read");
    // The answer depends on who asks (a private circuit is 404 to strangers) as well as on Accept.
    response.vary("Accept").vary("Authorization");
    const current = circuitETag(facts.version, form);
    if (isNotModified(header(request.headers["if-none-match"]), current)) {
      response.set("ETag", current).status(304).end();
      return;
    }
    const record = await this.circuits.load(id);
    // The tag of what is sent: the circuit may have been edited since the access check.
    response.set("ETag", circuitETag(record.version, form));
    if (mediaType === MEDIA_TYPES.json) {
      response.json(circuitResource(record));
      return;
    }
    response.type(contentType(MEDIA_TYPES.netlist));
    await sendStream(response, formatNetlist(record));
  }

  @Put(":id")
  async replace(
    @Param("id") id: string,
    @Headers("if-match") ifMatch: string | undefined,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CircuitResource> {
    const { input } = await readCircuitBody("replaceCircuit", request);
    const record = await this.circuits.replace(id, input, ifMatch, user);
    response.set("ETag", circuitETag(record.version));
    return circuitResource(record);
  }

  @Patch(":id")
  async updateMetadata(
    @Param("id") id: string,
    @Headers("if-match") ifMatch: string | undefined,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CircuitResource> {
    // The media type first: a body in the wrong format is 415, not a confusing validation error.
    requestMediaType("updateCircuitMetadata", header(request.headers["content-type"]));
    const record = await this.circuits.updateMetadata(id, parseMetadataPatch(request.body), ifMatch, user);
    response.set("ETag", circuitETag(record.version));
    return circuitResource(record);
  }

  @Delete(":id")
  @HttpCode(204)
  async delete(@Param("id") id: string, @Headers("if-match") ifMatch: string | undefined, @CurrentUser() user: AuthUser): Promise<void> {
    await this.circuits.delete(id, ifMatch, user);
  }
}
