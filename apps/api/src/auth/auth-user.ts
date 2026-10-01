import { unauthenticated } from "@circuitlab/api-contract";
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

/** The signed-in user making a request, as proven by their access token. */
export interface AuthUser {
  readonly id: string;
}

/**
 * Who made each request, recorded by AuthenticationGuard. A WeakMap rather than a property on the
 * request: nothing else can set it, and it goes away with the request.
 */
const users = new WeakMap<Request, AuthUser>();

export function setAuthUser(request: Request, user: AuthUser): void {
  users.set(request, user);
}

export function authUserOf(request: Request): AuthUser | undefined {
  return users.get(request);
}

/** The signed-in user. A request without a token gets 401 before the handler runs. */
export const CurrentUser = createParamDecorator((_: unknown, context: ExecutionContext): AuthUser => {
  const user = authUserOf(context.switchToHttp().getRequest<Request>());
  if (user === undefined) throw unauthenticated();
  return user;
});

/** The signed-in user, or undefined for a request without a token (which may still read public circuits). */
export const OptionalUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): AuthUser | undefined => authUserOf(context.switchToHttp().getRequest<Request>()),
);
