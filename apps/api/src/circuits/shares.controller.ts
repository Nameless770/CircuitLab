import { parseShareRequest, requestMediaType } from "@circuitlab/api-contract";
import type { ShareList, ShareResource } from "@circuitlab/api-contract";
import { Controller, Delete, Get, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { CurrentUser, type AuthUser } from "../auth/auth-user";
import { header } from "../common/http";
import { SharesService } from "./shares.service";

/** `/v1/circuits/{id}/shares`. Every handler needs a signed-in user. */
@Controller({ path: "circuits/:id/shares", version: "1" })
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  @Get()
  list(@Param("id") id: string, @CurrentUser() user: AuthUser): Promise<ShareList> {
    return this.shares.list(id, user);
  }

  /** 201 for a new share, 200 when an existing one changed role. */
  @Post()
  async share(
    @Param("id") id: string,
    @CurrentUser() user: AuthUser,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ShareResource> {
    requestMediaType("shareCircuit", header(request.headers["content-type"]));
    const { share, created } = await this.shares.share(id, user, parseShareRequest(request.body));
    response.status(created ? 201 : 200);
    return share;
  }

  @Delete(":userId")
  @HttpCode(204)
  async remove(@Param("id") id: string, @Param("userId") userId: string, @CurrentUser() user: AuthUser): Promise<void> {
    await this.shares.remove(id, user, userId);
  }
}
