import { ApiError, toProblem } from "@circuitlab/api-contract";
import { Catch, HttpException, Logger } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import type { Request, Response } from "express";
import { outageAsProblem } from "./outages";

/**
 * Every error, from any layer, leaves the API through here as an RFC 9457 problem document. The
 * mapping itself is the contract's `toProblem()`; this filter only translates what Express and
 * Nest throw into the contract's terms, logs what deserves it, and writes the response.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger("HTTP");

  catch(exception: unknown, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<Request>();
    const response = host.switchToHttp().getResponse<Response>();
    const path = request.originalUrl.split("?")[0] ?? "";
    const problem = toProblem(translate(exception, request.method, path), path);

    if (problem.status === 500) {
      this.logger.error(`${request.method} ${path} failed`, exception instanceof Error ? exception.stack : String(exception));
    } else if (problem.status === 503) {
      this.logger.warn(`${request.method} ${path}: ${problem.body.code}`);
    }

    if (response.headersSent) {
      // Part of a streamed body is already out, so a problem document can't be sent. Cutting the
      // connection makes the client see an incomplete response rather than a truncated one that
      // looks complete.
      response.destroy();
      return;
    }
    if (problem.status === 499 || response.destroyed) return; // the client has gone
    response.status(problem.status).set(problem.headers).json(problem.body);
  }
}

/**
 * Errors that come from Nest or Node rather than from our own code, in the contract's terms.
 * (Body-parser errors are translated where they happen; see json-body.ts.)
 */
function translate(exception: unknown, method: string, path: string): unknown {
  // A client that disconnects mid-upload or mid-download.
  const code = (exception as { code?: unknown } | null)?.code;
  if (code === "ECONNRESET" || code === "ERR_STREAM_PREMATURE_CLOSE") return new DOMException("The client disconnected", "AbortError");

  // The database or Redis is down (or out of connections): worth retrying, and not a bug in the
  // API. Redis is needed by the job queue, job results, and the sign-in throttle; the cache isn't,
  // since its failures are treated as misses.
  const outage = outageAsProblem(exception);
  if (outage !== exception) return outage;

  // Nest's own HTTP exceptions: the 404 for a path no controller handles, and the 400 for a path
  // with broken percent-encoding such as "%FF".
  if (exception instanceof HttpException) {
    switch (exception.getStatus()) {
      case 404:
        return new ApiError("not-found", `There is no ${method} ${path} endpoint. The API lives under /v1.`);
      case 400:
        return new ApiError("invalid-request", exception.message);
    }
  }
  return exception;
}
