import { bearerToken } from "@circuitlab/api-contract";
import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { setAuthUser } from "./auth-user";
import { TokenService } from "./tokens.service";

const IGNORES_ACCESS_TOKEN = "circuitlab:ignoresAccessToken";

/**
 * For the account endpoints: they work without an access token, and an expired one (which a client
 * may well still be sending when it calls /auth/refresh) must not get in the way.
 */
export const IgnoresAccessToken = (): ClassDecorator & MethodDecorator => SetMetadata(IGNORES_ACCESS_TOKEN, true);

/**
 * Runs before every handler (it is the app's global guard). A request with an access token gets
 * it checked: if valid, the user is recorded for @CurrentUser() and @OptionalUser(); if not, the
 * answer is 401 rather than quietly treating the request as anonymous, which would only make the
 * caller wonder where their circuits went. A request without a token passes as anonymous; the
 * handlers decide whether that is enough.
 *
 * Authentication only: what the user may do with a circuit is decided by CircuitsService.
 */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IGNORES_ACCESS_TOKEN, [context.getHandler(), context.getClass()]) === true) return true;
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (header !== undefined) setAuthUser(request, await this.tokens.verify(bearerToken(header)));
    return true;
  }
}
