import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { PipeTransform } from "@nestjs/common";
import type { Response } from "express";

/**
 * Runs a parser from @circuitlab/api-contract as a Nest pipe, e.g.
 * `@Query(new ParseWith(parseListCircuitsQuery))`. The rules live in the contract (and so in
 * openapi.yaml); this only plugs them into Nest.
 */
export class ParseWith<T> implements PipeTransform<unknown, T> {
  constructor(private readonly parse: (value: unknown) => T) {}

  transform(value: unknown): T {
    return this.parse(value);
  }
}

/**
 * An AbortSignal for the current request. It fires when the client disconnects before the answer
 * is complete, so a simulation nobody is waiting for stops occupying a worker. With a time limit
 * it also fires then, as a TimeoutError, which the API answers with 503.
 */
export function requestSignal(response: Response, timeoutMs?: number): AbortSignal {
  const clientGone = new AbortController();
  response.once("close", () => {
    if (!response.writableFinished) clientGone.abort(new DOMException("The client disconnected", "AbortError"));
  });
  return timeoutMs === undefined ? clientGone.signal : AbortSignal.any([clientGone.signal, AbortSignal.timeout(timeoutMs)]);
}

/** Injects `requestSignal(response, timeoutMs)` as a handler parameter. */
export const RequestSignal = createParamDecorator((timeoutMs: number | undefined, context: ExecutionContext): AbortSignal =>
  requestSignal(context.switchToHttp().getResponse<Response>(), timeoutMs),
);

/**
 * Sends text chunks as the response body. `pipeline` handles backpressure (chunks are produced
 * only as fast as the client reads them) and, if the client disconnects, destroys the source,
 * which stops whatever simulation is feeding it.
 */
export async function sendStream(response: Response, chunks: AsyncIterable<string> | Iterable<string>): Promise<void> {
  await pipeline(Readable.from(chunks), response);
}

/** A Content-Type value; text formats state their character set. */
export function contentType(mediaType: string): string {
  return mediaType.startsWith("text/") ? `${mediaType}; charset=utf-8` : mediaType;
}

/** A single-valued request header (the last one wins if a client repeats it). */
export function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.at(-1) : value;
}
