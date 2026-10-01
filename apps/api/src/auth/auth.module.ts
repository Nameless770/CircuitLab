import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController, UsersController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthenticationGuard } from "./authentication.guard";
import { PasswordsService } from "./passwords.service";
import { SignInThrottle } from "./sign-in-throttle";
import { TokenService } from "./tokens.service";

/**
 * Accounts, sessions, and authentication. UsersRepository and SessionsRepository come from
 * StorageModule. AuthenticationGuard is registered as the app's global guard, so every request's
 * token is checked before any handler runs.
 */
@Module({
  controllers: [AuthController, UsersController],
  providers: [AuthService, TokenService, PasswordsService, SignInThrottle, { provide: APP_GUARD, useClass: AuthenticationGuard }],
})
export class AuthModule {}
