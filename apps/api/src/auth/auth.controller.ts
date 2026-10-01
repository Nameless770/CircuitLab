import { parseRefreshRequest, parseRegisterRequest, parseSignInRequest, requestMediaType } from "@circuitlab/api-contract";
import type { AuthSession, UserResource } from "@circuitlab/api-contract";
import { Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { header } from "../common/http";
import { CurrentUser, type AuthUser } from "./auth-user";
import { AuthService } from "./auth.service";
import { IgnoresAccessToken } from "./authentication.guard";

/** `/v1/auth/...`: registering, signing in and out, refreshing tokens. */
@Controller({ path: "auth", version: "1" })
@IgnoresAccessToken()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")
  @HttpCode(201)
  register(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<AuthSession> {
    requestMediaType("register", header(request.headers["content-type"]));
    noStore(response);
    return this.auth.register(parseRegisterRequest(request.body));
  }

  @Post("login")
  @HttpCode(200)
  login(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<AuthSession> {
    requestMediaType("login", header(request.headers["content-type"]));
    noStore(response);
    // The socket's address. Behind a reverse proxy (phase 11) it is the proxy's, and Express's
    // "trust proxy" setting must be configured for request.ip to be the client's.
    return this.auth.login(parseSignInRequest(request.body), request.ip ?? "");
  }

  @Post("refresh")
  @HttpCode(200)
  refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<AuthSession> {
    requestMediaType("refreshSession", header(request.headers["content-type"]));
    noStore(response);
    return this.auth.refresh(parseRefreshRequest(request.body).refreshToken);
  }

  @Post("logout")
  @HttpCode(204)
  async logout(@Req() request: Request): Promise<void> {
    requestMediaType("logout", header(request.headers["content-type"]));
    await this.auth.logout(parseRefreshRequest(request.body).refreshToken);
  }
}

/** `/v1/users/me`. */
@Controller({ path: "users", version: "1" })
export class UsersController {
  constructor(private readonly auth: AuthService) {}

  @Get("me")
  me(@CurrentUser() user: AuthUser): Promise<UserResource> {
    return this.auth.me(user);
  }
}

/** Tokens must not be kept by any cache (RFC 6749 asks the same of OAuth token responses). */
function noStore(response: Response): void {
  response.set("Cache-Control", "no-store");
}
