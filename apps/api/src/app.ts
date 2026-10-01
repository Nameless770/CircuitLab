import "reflect-metadata";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { VersioningType, type LogLevel } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { SystemClock, type Clock } from "./common/clock";
import { jsonBody } from "./common/json-body";
import { AppConfig } from "./config/app-config";

export interface CreateAppOptions {
  /** Default: read from environment variables. */
  readonly config?: AppConfig;
  /** Log levels to print. Default: Nest's usual set. */
  readonly logLevels?: LogLevel[];
  /** Default: the system's. Tests pass one they can move forward. */
  readonly clock?: Clock;
}

/**
 * Builds the configured application without starting to listen, so the server (main.ts), the
 * demos, and later the integration tests (phase 8) all run exactly the same app.
 */
export async function createApp(options: CreateAppOptions = {}): Promise<NestExpressApplication> {
  const config = options.config ?? AppConfig.fromEnvironment();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(config, options.clock ?? new SystemClock()), {
    bodyParser: false,
    ...(options.logLevels !== undefined && { logger: options.logLevels }),
  });

  app.use(jsonBody);

  // Routes are /v1/...; a /v2 can live next to it later, route by route.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });

  // On SIGTERM or SIGINT: stop taking requests, drain those in flight, then run shutdown hooks
  // (which close the simulation pool).
  app.enableShutdownHooks();

  // While draining, Node's server.close() waits for every connection to end, and a keep-alive
  // connection that goes idle after its last response would otherwise linger for the whole
  // keep-alive timeout (5 s). So once the server has stopped listening, each finished response
  // closes the connections that have become idle.
  const server: Server = app.getHttpServer();
  server.on("request", (_request: IncomingMessage, response: ServerResponse) => {
    response.once("finish", () => {
      if (!server.listening) server.closeIdleConnections();
    });
  });

  const express = app.getHttpAdapter().getInstance();
  express.disable("x-powered-by"); // don't advertise the framework
  express.set("etag", false); // ETags are the API's own: they name circuit versions (docs/api-design.md)
  return app;
}
