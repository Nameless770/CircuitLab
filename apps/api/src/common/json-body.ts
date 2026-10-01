import { ApiError, LIMITS, MEDIA_TYPES } from "@circuitlab/api-contract";
import { json, type NextFunction, type Request, type RequestHandler, type Response } from "express";

const parse = json({ limit: LIMITS.maxBodyBytes, type: [MEDIA_TYPES.json, MEDIA_TYPES.mergePatch] });

/**
 * Express's JSON body parser, with its errors put in the contract's terms right where they
 * happen. (Left alone, Nest turns an invalid-JSON error into a generic 400 and loses what kind
 * of error it was.) Only JSON bodies are parsed; netlist uploads stay unread until a controller
 * streams them into the netlist parser.
 */
export const jsonBody: RequestHandler = (request: Request, response: Response, next: NextFunction) => {
  parse(request, response, (error?: unknown) => next(error === undefined ? undefined : describe(error)));
};

function describe(error: unknown): unknown {
  switch ((error as { type?: unknown }).type) {
    case "entity.parse.failed":
      return new ApiError("malformed-body", `The body is not valid JSON: ${(error as Error).message}`);
    case "entity.too.large":
      return new ApiError("content-too-large", `The body is larger than ${LIMITS.maxBodyBytes / (1024 * 1024)} MB.`);
    case "encoding.unsupported":
    case "charset.unsupported":
      return new ApiError("unsupported-media-type", (error as Error).message);
    case "request.aborted":
      return new DOMException("The client disconnected", "AbortError");
    default:
      return error;
  }
}
